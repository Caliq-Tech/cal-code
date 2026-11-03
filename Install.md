# Installing Calcode

Calcode is a terminal AI coding agent with a managed secret key, a managed provider and mandatory audit logging.

- Repo: https://github.com/Caliq-Tech/cal-code
- Releases: https://github.com/Caliq-Tech/cal-code/releases

## Quick install

The same command works on macOS, Linux and Windows (via Git Bash or WSL):

```bash
curl -fsSL https://raw.githubusercontent.com/Caliq-Tech/cal-code/master/install | bash
```

The installer detects your OS and CPU, downloads the matching binary from the latest GitHub release, puts it in `~/.calcode/bin` and adds that folder to your `PATH`. Open a new terminal afterwards (or `source ~/.zshrc` / `source ~/.bashrc`).

Verify:

```bash
calcode --version
```

### macOS

Apple Silicon and Intel are both detected automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/Caliq-Tech/cal-code/master/install | bash
```

### Linux

x64 and arm64 are supported, including musl (Alpine). Requires `curl` and `tar`.

```bash
curl -fsSL https://raw.githubusercontent.com/Caliq-Tech/cal-code/master/install | bash
```

### Windows

The installer is a bash script. Run it from **Git Bash** (https://git-scm.com) or **WSL**. It requires `curl` and `unzip`.

```bash
curl -fsSL https://raw.githubusercontent.com/Caliq-Tech/cal-code/master/install | bash
```

No bash available? Install manually: download `calcode-windows-x64.zip` from the releases page, extract `calcode.exe`, and add its folder to your `PATH`.

## Installer options

```bash
# Install a specific version
curl -fsSL https://raw.githubusercontent.com/Caliq-Tech/cal-code/master/install | bash -s -- --version 1.0.4

# Don't touch shell config files (.zshrc, .bashrc, ...)
curl -fsSL https://raw.githubusercontent.com/Caliq-Tech/cal-code/master/install | bash -s -- --no-modify-path

# Install from a local binary you already downloaded
./install --binary /path/to/calcode

# Help
./install --help
```

## Manual install from a release

Download the archive for your platform from the release page (e.g. https://github.com/Caliq-Tech/cal-code/releases/tag/v1.0.4), extract it and put the `calcode` binary on your `PATH`.

| Platform | Asset |
|---|---|
| macOS Apple Silicon | `calcode-darwin-arm64.zip` |
| macOS Intel | `calcode-darwin-x64.zip` (`-baseline` for CPUs without AVX2) |
| Linux x64 | `calcode-linux-x64.tar.gz` (`-baseline`, `-musl` variants available) |
| Linux arm64 | `calcode-linux-arm64.tar.gz` (`-musl` variant available) |
| Windows x64 | `calcode-windows-x64.zip` (`-baseline` variant available) |
| Windows arm64 | `calcode-windows-arm64.zip` |

Example (macOS Apple Silicon):

```bash
unzip calcode-darwin-arm64.zip
mkdir -p ~/.local/bin && mv calcode ~/.local/bin/
```

## Build from source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/Caliq-Tech/cal-code
cd cal-code
make setup             # install deps, create admin/.env, run migrations
make calcode-install   # build a native binary and link it as `calcode` in ~/.local/bin
```

## First run and usage

```bash
calcode                               # start the terminal UI in the current project directory
calcode run "fix the failing tests"   # non-interactive, single prompt
calcode logout                        # forget the stored secret key
```

### Secret key

Calcode needs a secret key issued by your calcode admin.

1. On first run it prompts for the key (input is hidden).
2. It validates the key with the Calcode API and stores it in the data directory as `calcode.json` (file mode 0600). You are not asked again.
3. `calcode logout` removes the stored key.
4. For CI or other non-interactive use, set the key in the environment instead:

```bash
export CALCODE_KEY=<your-secret-key>
calcode run "summarize this repo"
```

An invalid key (HTTP 401/403) is cleared automatically and you are asked again.

### What to expect

- Every run fetches the provider and API key from the Calcode server; other providers are disabled.
- After each prompt turn an audit record is written locally and uploaded to S3. Failed uploads are queued and retried on the next turn or start.

## Updating and uninstalling

Update: re-run the install command (it fetches the latest release).

Uninstall:

```bash
rm -rf ~/.calcode
```

Then remove the `~/.calcode/bin` line from your shell config (`~/.zshrc`, `~/.bashrc`, ...).

## Troubleshooting

- `calcode: command not found`: open a new terminal, or add `export PATH="$HOME/.calcode/bin:$PATH"` to your shell config.
- `Release vX.Y.Z not found`: check the version exists on the releases page.
- `'unzip' is required` / `'tar' is required`: install the missing tool and re-run.
- Key rejected: ask your admin for a valid key, or run `calcode logout` and retry.
