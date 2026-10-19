/**
 * macOS LaunchAgent management: `aipool install` / `aipool uninstall`.
 * Keeps the daemon alive across logout/reboot on a Mac mini, logging to
 * ~/.aipool/aipool.log.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { aipoolHome, logPath, writeText } from './util.mjs'

export const LABEL = 'com.aipool.gateway'

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function plistFile() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

export function renderPlist({ nodePath, binPath, configFile, workingDir }) {
  const env = {
    AIPOOL_HOME: aipoolHome(),
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
  }
  if (configFile) env.AIPOOL_CONFIG = configFile
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(binPath)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
  <key>WorkingDirectory</key><string>${escapeXml(workingDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(logPath())}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath())}</string>
</dict>
</plist>
`
}

function run(command, args, { ignoreErrors = false } = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (ignoreErrors) return ''
    throw new Error(`${command} ${args.join(' ')} failed: ${error.stderr || error.message}`)
  }
}

export function install({ binPath }) {
  const file = plistFile()
  const content = renderPlist({
    nodePath: process.execPath,
    binPath: resolve(binPath),
    configFile: process.env.AIPOOL_CONFIG ?? null,
    workingDir: homedir(),
  })
  writeText(file, content, 0o644)
  const uid = process.getuid()
  run('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { ignoreErrors: true })
  run('launchctl', ['bootstrap', `gui/${uid}`, file])
  run('launchctl', ['enable', `gui/${uid}/${LABEL}`], { ignoreErrors: true })
  run('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`])
  return file
}

export function uninstall() {
  const uid = process.getuid()
  run('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { ignoreErrors: true })
  const file = plistFile()
  if (existsSync(file)) rmSync(file, { force: true })
  return file
}

export function status() {
  const uid = process.getuid()
  const output = run('launchctl', ['print', `gui/${uid}/${LABEL}`], { ignoreErrors: true })
  if (!output) return { installed: false, running: false, pid: null }
  const pidMatch = /pid = (\d+)/.exec(output)
  return {
    installed: existsSync(plistFile()),
    running: Boolean(pidMatch),
    pid: pidMatch ? Number(pidMatch[1]) : null,
  }
}
