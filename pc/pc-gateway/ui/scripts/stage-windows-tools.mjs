import { access, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const output = path.resolve(here, '..', 'build', 'windows-tools');
  const sdk = process.env.ANDROID_SDK_ROOT
    || process.env.ANDROID_HOME
    || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const adbRoot = path.join(sdk, 'platform-tools');
  const configuredFfmpeg = process.env.AGENTCALL_FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
  const files = [
    [path.join(adbRoot, 'adb.exe'), 'adb.exe'],
    [path.join(adbRoot, 'AdbWinApi.dll'), 'AdbWinApi.dll'],
    [path.join(adbRoot, 'AdbWinUsbApi.dll'), 'AdbWinUsbApi.dll'],
    [configuredFfmpeg, 'ffmpeg.exe'],
  ];
  for (const [source] of files) await access(source);
  await mkdir(output, { recursive: true });
  await Promise.all(files.map(([source, name]) => copyFile(source, path.join(output, name))));
  process.stdout.write(`Staged Windows runtime tools in ${output}\n`);
}
