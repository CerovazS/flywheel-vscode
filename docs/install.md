# Install

> [!note]
> The extension is currently distributed as a `.vsix` only — no Marketplace listing yet.

## From a release

1. Download the latest `flywheel-<version>.vsix` from the [Releases page](https://github.com/CerovazS/flywheel-vscode/releases).
2. Install it:

   ```bash
   code --install-extension flywheel-0.1.0.vsix
   ```

3. Reload VS Code (or just open it — activation is automatic).

## From source

See [development.md](./development.md). Short version:

```bash
git clone https://github.com/CerovazS/flywheel-vscode
cd flywheel-vscode
pnpm install
pnpm -r build
cd packages/flywheel-vscode
npx @vscode/vsce package --no-dependencies
code --install-extension flywheel-0.1.0.vsix
```

## Bearer token

> [!important]
> The extension calls Flywheel's MCP server, which needs a token.

Two options, in priority order:

1. **VS Code setting**: `flywheel.token` in your User or Workspace settings.
2. **`~/.claude.json`**: the extension reads `mcpServers.flywheel.headers.Authorization` and strips the `Bearer ` prefix.

```jsonc
// ~/.claude.json (excerpt)
{
  "mcpServers": {
    "flywheel": {
      "headers": {
        "Authorization": "Bearer fwk_<your-token>"
      }
    }
  }
}
```

## Upgrade

Drop the new `.vsix` in and re-run the install command — VS Code replaces the install in place:

```bash
code --install-extension flywheel-0.1.0.vsix --force
```

## Uninstall

```bash
code --uninstall-extension cerovazs.flywheel-vscode
```
