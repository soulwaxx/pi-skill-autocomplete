#!/usr/bin/env python3
"""Safely unpack the fixed five-file npm archive within bounded stream/content limits."""
import gzip
import os
import sys
import tarfile

LIMIT = 50 * 1024 * 1024
STREAM_LIMIT = 64 * 1024 * 1024
FILES = {
    "package/LICENSE",
    "package/README.md",
    "package/extensions/skill-autocomplete.ts",
    "package/extensions/skill-reference-parser.ts",
    "package/package.json",
}
DIRECTORIES = {"package", "package/extensions"}


class StrictTarInfo(tarfile.TarInfo):
    @classmethod
    def fromtarfile(cls, tar):
        try:
            return super().fromtarfile(tar)
        except tarfile.HeaderError as error:
            if isinstance(error, tarfile.EOFHeaderError):
                raise
            raise tarfile.ReadError(f"invalid tar header: {error}") from error


class BoundedReader:
    """Bound decompressed reads before tarfile can parse metadata or allocate it."""
    def __init__(self, stream, limit):
        self.stream = stream
        self.limit = limit
        self.read_bytes = 0

    def read(self, size=-1):
        remaining = self.limit - self.read_bytes
        if remaining < 0:
            raise ValueError("archive exceeds decompressed stream limit")
        requested = remaining + 1 if size < 0 else min(size, remaining + 1)
        data = self.stream.read(requested)
        self.read_bytes += len(data)
        if self.read_bytes > self.limit:
            raise ValueError("archive exceeds decompressed stream limit")
        return data


def unpack(archive, destination, content_limit=LIMIT, stream_limit=STREAM_LIMIT):
    seen = set()
    total = 0
    owned = False
    try:
        os.mkdir(destination)
        owned = True
        os.mkdir(os.path.join(destination, "package"))
        os.mkdir(os.path.join(destination, "package", "extensions"))
        with gzip.open(archive, mode="rb") as gzip_stream:
            bounded = BoundedReader(gzip_stream, stream_limit)
            with tarfile.open(fileobj=bounded, mode="r|", tarinfo=StrictTarInfo) as tar:
                for member in tar:
                    name = member.name
                    if name.startswith("./") or name.startswith("/") or "\\" in name or any(part in ("", ".", "..") for part in name.rstrip("/").split("/")):
                        raise ValueError("unsafe archive member path")
                    if name in seen:
                        raise ValueError("duplicate archive member")
                    seen.add(name)
                    if name in DIRECTORIES:
                        if not member.isdir():
                            raise ValueError("unexpected archive member type")
                        continue
                    if name not in FILES or not member.isreg() or getattr(member, "sparse", None):
                        raise ValueError("unexpected archive member or type")
                    total += member.size
                    if member.size < 0 or total > content_limit:
                        raise ValueError("archive exceeds file-content limit")
                    source = tar.extractfile(member)
                    if source is None:
                        raise ValueError("archive member has no data")
                    target = os.path.join(destination, *name.split("/"))
                    with source, open(target, "xb") as output:
                        remaining = member.size
                        while remaining:
                            chunk = source.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise ValueError("truncated archive member")
                            output.write(chunk)
                            remaining -= len(chunk)
                if tar.fileobj.tell() != tar.offset + tarfile.BLOCKSIZE:
                    raise ValueError("archive is missing its tar end marker")
                end_block = tar.fileobj.read(tarfile.BLOCKSIZE)
                if len(end_block) != tarfile.BLOCKSIZE or any(end_block):
                    raise ValueError("archive is missing its second tar end marker")
                while True:
                    trailing = tar.fileobj.read(1024 * 1024)
                    if not trailing:
                        break
                    if any(trailing):
                        raise ValueError("archive has nonzero data after tar end markers")
                if seen - DIRECTORIES != FILES:
                    raise ValueError("archive does not contain the exact five-file allowlist")
    except Exception:
        if owned:
            import shutil
            shutil.rmtree(destination, ignore_errors=True)
        raise


def main(archive, destination):
    unpack(archive, destination)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: validate-archive.py ARCHIVE DESTINATION")
    try:
        main(sys.argv[1], sys.argv[2])
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
