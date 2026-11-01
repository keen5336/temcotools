#!/usr/bin/env python3
"""Manage the isolated MacDev preview. Never discovers or targets production."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

QUALIFICATION = Path('/Volumes/MacDev/ProjectArchive/Development/Qualification')


def private_path(path, directory=False):
    if path.is_symlink() or not path.exists():
        raise ValueError('Runtime paths must exist and must not be symlinks.')
    resolved = path.resolve()
    resolved.relative_to(QUALIFICATION.resolve())
    mode = path.stat().st_mode
    if path.stat().st_uid != os.getuid() or mode & 0o077:
        raise ValueError('Private runtime configuration must be owned by this user and inaccessible to other users.')
    if directory != stat.S_ISDIR(mode):
        raise ValueError('Unexpected runtime path type.')
    return resolved


def configuration(runtime):
    environment = json.loads(private_path(runtime / 'environment.json').read_text())
    if not isinstance(environment, dict) or any(not isinstance(value, str) for value in environment.values()):
        raise ValueError('Expected a private environment object with string values.')
    database = urllib.parse.urlsplit(environment.get('DATABASE_URL', ''))
    if database.hostname != '127.0.0.1' or database.port != 55439 or database.path != '/temcotools_v2_preview_test' or database.query:
        raise ValueError('Only the task-owned isolated preview database is supported.')
    for key in ['NEXT_PUBLIC_APP_URL', 'MCP_ISSUER_URL', 'MCP_RESOURCE_URL']:
        url = urllib.parse.urlsplit(environment.get(key, ''))
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password or url.query or url.fragment:
            raise ValueError('Only explicit HTTP loopback preview URLs are supported.')
    if environment.get('MCP_HTTP_HOST') != '127.0.0.1':
        raise ValueError('MCP must remain bound to loopback.')
    return environment


def process_matches(pid, source, command):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], text=True, capture_output=True)
    if result.returncode or command not in result.stdout or 'dev-run -- node ' not in result.stdout:
        return False
    cwd = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], text=True, capture_output=True)
    try:
        return ('n' + str(source)) in cwd.stdout.splitlines() and os.getpgid(pid) == pid
    except ProcessLookupError:
        return False


def recorded_pid(runtime, name):
    path = runtime / (name + '.pid')
    if not path.exists():
        return None
    return int(private_path(path).read_text().strip())


def health(url, expected):
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status == expected
    except urllib.error.HTTPError as error:
        return error.code == expected
    except (OSError, urllib.error.URLError):
        return False


def run(args):
    if not Path('/Volumes/MacDev').is_mount():
        raise ValueError('MacDev must be mounted; no internal fallback is allowed.')
    runtime = private_path(Path(args.runtime_dir), directory=True)
    source = Path(args.source).resolve(strict=True)
    source.relative_to(QUALIFICATION.resolve())
    if not (source / '.next/BUILD_ID').is_file() or not (source / 'scripts/mcp-http-server.ts').is_file():
        raise ValueError('Use the retained, built preview release directory.')
    environment = configuration(runtime)
    app_url = environment['NEXT_PUBLIC_APP_URL'].rstrip('/')
    issuer = environment['MCP_ISSUER_URL'].rstrip('/')
    app_port = urllib.parse.urlsplit(app_url).port
    mcp_port = int(environment['MCP_HTTP_PORT'])
    if urllib.parse.urlsplit(issuer).port != mcp_port or app_port == mcp_port:
        raise ValueError('Preview listener configuration does not match its URLs.')
    services = [
        ('mcp', ['node', '--import', 'tsx', 'scripts/mcp-http-server.ts'], mcp_port, issuer + '/.well-known/oauth-authorization-server'),
        ('app', ['node', 'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', str(app_port)], app_port, app_url + '/signin'),
    ]
    lock_fd = os.open(runtime / '.services.lock', os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for name, command, port, url in services:
            pid = recorded_pid(runtime, name)
            running = pid is not None and process_matches(pid, source, ' '.join(command))
            if args.action == 'stop' and running:
                os.killpg(pid, signal.SIGTERM)
                for _ in range(50):
                    if not process_matches(pid, source, ' '.join(command)):
                        break
                    time.sleep(0.1)
                else:
                    raise ValueError('Preview did not stop; preserved PID/log evidence. No forced kill was attempted.')
                running = False
            elif args.action == 'start' and not running:
                # Never replace an unknown listener or infer an external outcome.
                with socket.socket() as probe:
                    if probe.connect_ex(('127.0.0.1', port)) == 0:
                        raise ValueError('Preview port is occupied by an unowned process; inspect it before proceeding.')
                runner = shutil.which('dev-run')
                if not runner:
                    raise ValueError('dev-run is required for preview storage routing.')
                log_fd = os.open(runtime / (name + '.log'), os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
                with os.fdopen(log_fd, 'ab') as log:
                    child = subprocess.Popen([runner, '--', *command], cwd=source, env={**os.environ, **environment}, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
                pid = child.pid
                pid_fd = os.open(runtime / (name + '.pid'), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
                with os.fdopen(pid_fd, 'w') as pid_file:
                    pid_file.write(str(pid) + '\n')
                for _ in range(50):
                    if health(url, 200):
                        break
                    if child.poll() is not None:
                        raise ValueError('Preview exited; inspect its protected log without printing credentials.')
                    time.sleep(0.1)
                running = process_matches(pid, source, ' '.join(command))
                if not running or not health(url, 200):
                    raise ValueError('Preview is not healthy; retained PID/log evidence. It will not be restarted automatically.')
            print(json.dumps({'service': name, 'supervisorPid': pid, 'ownedProcessRunning': running, 'healthy': running and health(url, 200), 'url': url}))
        if args.action != 'stop':
            print(json.dumps({'mcpResource': environment['MCP_RESOURCE_URL'], 'unauthenticatedRequestDenied': health(environment['MCP_RESOURCE_URL'], 401), 'exposure': 'loopback only; no public proxy or client registration configured'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'start', 'stop'])
    parser.add_argument('--runtime-dir', required=True, help='Existing private MacDev Qualification directory; contains environment.json, logs and PID files.')
    parser.add_argument('--source', required=True, help='Retained optimized release directory, never the changing worktree.')
    try:
        run(parser.parse_args())
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print('Preview operation refused or failed. Verify the mounted release, private configuration, PID ownership and protected logs; no secrets were printed.', file=sys.stderr)
        sys.exit(1)
