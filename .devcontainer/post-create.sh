#!/usr/bin/env bash
# Runs once when a Codespace or dev container is created.
# Set CWS_SKIP_AGENT_CLIS=1 to skip installing the agent command-line tools.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

step() { printf '\n==> %s\n' "$1"; }
optional() { "$@" || printf 'warning: optional step failed: %s\n' "$*" >&2; }

step "Installing pnpm and project dependencies"
npm install --global pnpm@10
pnpm install --frozen-lockfile

step "Building cws"
npm run build

step "Putting cws on the PATH"
bin_dir="$(npm prefix --global)/bin"
cat > "$bin_dir/cws" <<EOF
#!/usr/bin/env sh
exec node "$repo/dist/cli/main.js" "\$@"
EOF
chmod +x "$bin_dir/cws"

if [ "${CWS_SKIP_AGENT_CLIS:-0}" != "1" ]; then
  step "Installing agent command-line tools (optional)"
  optional npm install --global @anthropic-ai/claude-code
  optional npm install --global @openai/codex
  optional npm install --global @google/gemini-cli
  optional npm install --global @github/copilot
fi

step "Installing uv for Python-based agent skills (optional)"
optional python3 -m pip install --user --quiet uv

cat <<'MSG'

CWS is ready.

Sign in once per new Codespace (your subscriptions, no API keys):
  GitHub Copilot   gh auth login        (VS Code then picks up Copilot)
  Claude Code      claude               (sign in with your Claude subscription)
  Codex            codex login          (sign in with your account)
  Gemini CLI       gemini               (sign in with your Google account)

Memory:
  New project:      cws init "My idea"   then   cws install-agents
  Restore memory:   upload your backup file, then   cws import <file>
  Every "cws session end" saves a backup in .cws/backups. Download it now and then:
  a Codespace that is unused for 30 days is deleted together with everything in it.
  Stop the Codespace when you are done so it does not use up free hours.

Check what is available here:
  cws doctor
MSG
