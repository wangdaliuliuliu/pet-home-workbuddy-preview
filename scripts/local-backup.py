import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tempfile
import zipfile


LIMIT = 1024 * 1024 * 1024
MARKER = 'pet-local-backup.json'
PRIVATE = {'local-hall-link.json', 'companion-voice-private.json', 'local-ai-settings.json', 'workbuddy-install-check.json'}


def allowed(name):
    path = PurePosixPath(name)
    return (
        not path.is_absolute() and '\\' not in name and ':' not in name
        and '/'.join(path.parts) == name and all(p not in {'.', '..'} and not p.startswith('.') for p in path.parts)
        and not path.name.endswith(('.tmp', '.lock', '.env', '.claimed'))
        and path.name not in PRIVATE
    )


def backup(source, target):
    if target.exists() or not source.joinpath('accounts.json').is_file():
        raise ValueError('需要一个已有的宠物存档和一个还不存在的备份文件。')
    if not target.parent.is_dir() or target.is_relative_to(source):
        raise ValueError('请把备份放在存档目录之外。')
    fd, name = tempfile.mkstemp(prefix='pet-backup-', suffix='.partial', dir=target.parent)
    os.close(fd)
    temp = Path(name)
    try:
        size = 0
        with zipfile.ZipFile(temp, 'w', compression=zipfile.ZIP_STORED) as archive:
            archive.writestr(MARKER, '{"version":1}')
            for base, dirs, files in os.walk(source):
                base = Path(base)
                dirs[:] = [d for d in dirs if allowed((base / d).relative_to(source).as_posix()) and not (base / d).is_symlink()]
                for item in sorted(files):
                    file = base / item
                    relative = file.relative_to(source).as_posix()
                    if relative == MARKER or not allowed(relative) or file.is_symlink() or not file.is_file():
                        continue
                    size += file.stat().st_size
                    if size > LIMIT:
                        raise ValueError('存档超过 1 GB。请关闭小家后由家长复制整个本地数据目录。')
                    if relative == 'accounts.json':
                        users = json.loads(file.read_text(encoding='utf-8'))['users']
                        archive.writestr(relative, json.dumps({'users': users, 'sessions': {}}, ensure_ascii=False))
                    else:
                        archive.write(file, relative)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as out, temp.open('rb') as src:
            shutil.copyfileobj(src, out)
    finally:
        temp.unlink(missing_ok=True)


def restore(archive_file, target):
    if target.exists():
        raise ValueError('请还原到一个尚不存在的存档目录，现有宠物资料不会被覆盖。')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pet-restore-', dir=target.parent) as directory:
        temp = Path(directory) / 'snapshot'
        temp.mkdir(mode=0o700)
        with zipfile.ZipFile(archive_file) as archive:
            entries = archive.infolist()
            names = {item.filename for item in entries}
            if (len(entries) != len(names) or sum(item.file_size for item in entries) > LIMIT or
                not {MARKER, 'accounts.json'}.issubset(names) or archive.getinfo(MARKER).file_size > 256 or
                json.loads(archive.read(MARKER)) != {'version': 1}):
                raise ValueError('这不是完整的小家备份。')
            for item in entries:
                name = item.filename
                if name == MARKER:
                    continue
                if not allowed(name) or item.is_dir() or stat.S_ISLNK(item.external_attr >> 16):
                    raise ValueError('备份里有不支持的文件路径。')
                out = temp / name
                out.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as src, out.open('xb') as destination:
                    shutil.copyfileobj(src, destination)
        db = json.loads(temp.joinpath('accounts.json').read_text(encoding='utf-8'))
        if not isinstance(db.get('users'), list):
            raise ValueError('备份里的账号资料不完整。')
        db['sessions'] = {}
        db.pop('devices', None)
        temp.joinpath('accounts.json').write_text(json.dumps(db, ensure_ascii=False), encoding='utf-8')
        if target.exists():
            raise ValueError('存档目录已出现，请选择一个空白位置。')
        temp.rename(target)


if __name__ == '__main__':
    try:
        operation, source, target = sys.argv[1:]
        {'backup': backup, 'restore': restore}[operation](Path(source).resolve(), Path(target).resolve())
        print(target)
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
