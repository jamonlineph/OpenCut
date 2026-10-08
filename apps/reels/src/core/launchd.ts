import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { run, which } from "./exec";
import { selfCommand } from "./runtime";
import type { Workspace } from "./workspace";

// Runs OpenCut Studio (and with it the auto-edit autopilot) at login on macOS,
// so dropping a video into the auto-edit folder works any time.

export const LABEL = "app.opencut.studio";
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchAgentPlist(ws: Workspace): string {
  const program = selfCommand("studio");
  const env: Record<string, string> = {
    PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(homedir(), ".bun", "bin"), join(homedir(), ".local", "bin")].join(":"),
    OPENCUT_WORKSPACE: ws.root,
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${program.map((a) => `      <string>${xml(a)}</string>`).join("\n")}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(ws.root)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(join(ws.autopilot, "studio.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(ws.autopilot, "studio.log"))}</string>
  </dict>
</plist>
`;
}

export async function installLaunchAgent(ws: Workspace): Promise<string> {
  const launchctl = which("launchctl");
  if (!launchctl) throw new Error("Run-at-login is only available on macOS.");
  const file = plistPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  if (existsSync(file)) await run([launchctl, "unload", file]);
  writeFileSync(file, launchAgentPlist(ws));
  const result = await run([launchctl, "load", "-w", file]);
  if (result.code !== 0) throw new Error(`launchctl failed: ${result.stderr.trim()}`);
  return file;
}

export async function uninstallLaunchAgent(): Promise<boolean> {
  const launchctl = which("launchctl");
  const file = plistPath();
  if (!existsSync(file)) return false;
  if (launchctl) await run([launchctl, "unload", "-w", file]);
  rmSync(file, { force: true });
  return true;
}
