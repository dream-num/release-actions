"""Read one bounded receipt in memory; never extract to disk."""
import io
import sys
import zipfile

limit = 65536
try:
    data = sys.stdin.buffer.read(limit + 1)
    if len(data) > limit:
        raise ValueError()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if (len(members) != 1 or members[0].filename != "insider-receipt.json"
                or not 0 < members[0].file_size <= limit):
            raise ValueError()
        with archive.open(members[0]) as receipt:
            body = receipt.read(limit + 1)
        if len(body) != members[0].file_size:
            raise ValueError()
    sys.stdout.buffer.write(body)
except Exception:
    sys.exit(1)
