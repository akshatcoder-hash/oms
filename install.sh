#!/bin/sh
set -eu

say() { printf '%s\n' "oms: $*"; }
die() { say "$*" >&2; exit 1; }

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die 'Supported platforms: macOS, Linux and WSL2.' ;;
esac
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die 'Supported architectures: x64 and arm64.' ;;
esac

OMS_HOME=${OMS_HOME:-"$HOME/.oms"}
case $OMS_HOME in /*) ;; *) die 'OMS_HOME must be an absolute path.' ;; esac
export OMS_HOME

if ! git --version >/dev/null 2>&1; then
  if [ "$os" = darwin ]; then
    say 'Git is required. Complete the Command Line Tools installation, then rerun this installer.'
    xcode-select --install || say 'Run: xcode-select --install'
    exit 1
  fi
  if command -v apt-get >/dev/null 2>&1; then
    git_install='apt-get update && sudo -n apt-get install -y git'
  elif command -v dnf >/dev/null 2>&1; then
    git_install='dnf install -y git'
  elif command -v yum >/dev/null 2>&1; then
    git_install='yum install -y git'
  elif command -v apk >/dev/null 2>&1; then
    git_install='apk add git'
  elif command -v pacman >/dev/null 2>&1; then
    git_install='pacman -S --needed --noconfirm git'
  elif command -v zypper >/dev/null 2>&1; then
    git_install='zypper --non-interactive install git'
  else
    die 'Install Git using your distribution package manager, then rerun this installer.'
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    say 'Installing Git with the system package manager.'
    sh -c "sudo -n $git_install"
  else
    die "Git is required. Run: sudo $git_install"
  fi
fi

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || die "Install $tool, then rerun this installer."
done
mkdir -p "$OMS_HOME/bin"
node_ok() {
  "$1" -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && (b>19 || (b===19 && c>=0))) ? 0 : 1)' >/dev/null 2>&1
}
node_bin=$(command -v node || true)
if [ -n "$node_bin" ] && node_ok "$node_bin" && command -v npm >/dev/null 2>&1; then
  say 'Using system Node.'
elif [ -x "$OMS_HOME/node/bin/node" ] && node_ok "$OMS_HOME/node/bin/node"; then
  node_bin=$OMS_HOME/node/bin/node
  say 'Using private Node.'
else
  node_version=22.22.2
  archive="node-v$node_version-$os-$arch.tar.gz"
  say "Installing Node $node_version in $OMS_HOME/node."
  work=$(mktemp -d "$OMS_HOME/.node-download.XXXXXX")
  trap 'rm -rf "$work"' 0
  trap 'exit 1' HUP INT TERM
  curl -fsSL "https://nodejs.org/dist/v$node_version/$archive" -o "$work/$archive"
  curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  expected=$(awk -v file="$archive" '$2 == file {print $1}' "$work/SHASUMS256.txt")
  [ -n "$expected" ] || die 'Node checksum not found.'
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$work/$archive")
  else
    actual=$(shasum -a 256 "$work/$archive")
  fi
  [ "${actual%% *}" = "$expected" ] || die 'Node checksum mismatch.'
  mkdir "$work/node"
  tar -xzf "$work/$archive" -C "$work/node" --strip-components=1
  rm -rf "$OMS_HOME/node"
  mv "$work/node" "$OMS_HOME/node"
  rm -rf "$work"
  trap - 0 HUP INT TERM
  node_bin=$OMS_HOME/node/bin/node
fi
PATH="$(dirname "$node_bin"):$PATH"
export PATH
say "Installing @barestate/oms@${OMS_VERSION:-latest}."
npm install -g --prefix "$OMS_HOME/cli" --ignore-scripts --no-audit --no-fund "@barestate/oms@${OMS_VERSION:-latest}"

# Quote paths for a shell script, including home directories containing apostrophes.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
{
  printf '#!/bin/sh\n'
  # shellcheck disable=SC2016
  printf 'PATH=%s:"$PATH"\nexport PATH\n' "$(quote "$(dirname "$node_bin")")"
  printf 'exec %s %s "$@"\n' "$(quote "$node_bin")" "$(quote "$OMS_HOME/cli/bin/oms")"
} > "$OMS_HOME/bin/oms"
chmod +x "$OMS_HOME/bin/oms"

if [ "${OMS_NO_MODIFY_PATH:-0}" != 1 ]; then
  case ${SHELL:-} in
    */zsh) rc=$HOME/.zshrc ; line="export PATH=$(quote "$OMS_HOME/bin"):\"\$PATH\"" ;;
    */fish)
      mkdir -p "$HOME/.config/fish"
      rc=$HOME/.config/fish/config.fish
      line="fish_add_path $(quote "$OMS_HOME/bin")" ;;
    *) rc=$HOME/.bashrc ; line="export PATH=$(quote "$OMS_HOME/bin"):\"\$PATH\"" ;;
  esac
  if ! grep -Fqx "$line" "$rc" 2>/dev/null; then
    printf '\n%s\n' "$line" >> "$rc"
  fi
  say "PATH configured in $rc. Open a new shell to use oms."
fi
if [ "${OMS_SKIP_DOCTOR:-0}" != 1 ]; then
  "$OMS_HOME/bin/oms" doctor --install || say 'Doctor reported missing tools. Run oms doctor for details.'
fi
say "Installed. Run: $OMS_HOME/bin/oms"
