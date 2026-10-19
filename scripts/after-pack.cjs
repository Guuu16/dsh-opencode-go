// electron-builder afterPack hook: drop a compatibility launcher next to the
// exe. Chromium's sandbox cannot initialize in an elevated (Administrator)
// session, so the normal double-click may exit immediately; this launcher
// starts the same app with --no-sandbox.
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const exe = `${context.packager.appInfo.productFilename}.exe`
  const content = [
    '@echo off',
    'rem Chromium sandbox cannot start in an elevated session; use this launcher.',
    `start "" "%~dp0${exe}" --no-sandbox`,
    '',
  ].join('\r\n')
  writeFileSync(join(context.appOutDir, '启动-兼容模式.cmd'), content, 'utf8')
}
