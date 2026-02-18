# 🦀 ClawRoute

**Intelligent cost-optimizing model router for OpenClaw**

Save 60-90% on your LLM costs by automatically routing requests to cheaper models when appropriate.

> **v1.2** — Intelligent, local, and private. Updated for the latest models (Feb 2026).
>
> Works with **any OpenAI-compatible client** — OpenClaw, Cursor, custom apps, or direct API calls. No special detection needed.

## How It Works

ClawRoute is a local HTTP proxy that sits between OpenClaw and your LLM providers. It:

1. **Intercepts** every LLM request from OpenClaw
2. **Classifies** the task complexity using local heuristics (no API calls, <5ms)
3. **Routes** to the cheapest model that can handle it
4. **Escalates** automatically if the cheap model fails (before streaming)

```
OpenClaw → ClawRoute (127.0.0.1:18790) → OpenAI/Anthropic/Google/DeepSeek
              ↓
     [Classify → Route → Execute]
              ↓
     SQLite logs (savings tracked)
```

## Quick Start

```bash
# Clone and install
git clone https://github.com/atharv404/ClawRoute && cd ClawRoute
npm install && npm run build

# Configure API keys
echo 'OPENAI_API_KEY=sk-xxx' >> .env
echo 'ANTHROPIC_API_KEY=sk-ant-xxx' >> .env
echo 'GOOGLE_API_KEY=AIzaXXX' >> .env
echo 'DEEPSEEK_API_KEY=sk-xxx' >> .env

# Start the proxy
npm start

# Configure OpenClaw to use ClawRoute
# Edit ~/.openclaw/openclaw.json:
#   providers.openai.baseUrl → "http://127.0.0.1:18790/v1"
```


## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | - | OpenAI API key |
| `ANTHROPIC_API_KEY` | - | Anthropic API key |
| `GOOGLE_API_KEY` | - | Google AI API key |
| `DEEPSEEK_API_KEY` | - | DeepSeek API key |
| `CLAWROUTE_PORT` | `18790` | Proxy port |
| `CLAWROUTE_HOST` | `127.0.0.1` | Bind address |
| `CLAWROUTE_TOKEN` | - | Auth token (optional) |
| `CLAWROUTE_DRY_RUN` | `false` | Classify but don't reroute |
| `CLAWROUTE_DEBUG` | `false` | Verbose logging |


### Model Mappings

Default tier → model mappings (as of Feb 2026):

| Tier | Primary Model | Fallback | Use Case |
|------|--------------|----------|----------|
| Heartbeat | `gemini-2.5-flash-lite` | `deepseek-chat` | Ping/status checks |
| Simple | `deepseek-chat` | `gemini-2.5-flash` | Acknowledgments, short replies |
| Moderate | `gemini-2.5-flash` | `gpt-5-mini` | General conversation |
| Complex | `claude-sonnet-4-6` | `gpt-5.2` | Tool use, analysis |
| Frontier | `claude-opus-4-6` | `o3` | Code, deep reasoning |

Customize in `config/clawroute.json`.

## Dry-Run Mode

Test ClawRoute risk-free:

```bash
# Enable dry-run
CLAWROUTE_DRY_RUN=true npm start

# Or toggle at runtime
curl -X POST http://127.0.0.1:18790/api/dry-run/enable
```

In dry-run mode, ClawRoute:
- Classifies every request
- Logs what it *would* have done
- Forwards to original model unchanged

## Dashboard

Access the real-time dashboard at: `http://127.0.0.1:18790/dashboard`

Features:
- Today's savings
- Tier breakdown chart
- Recent routing decisions
- Enable/disable controls

## CLI Commands

```bash
clawroute start              # Start the proxy server
clawroute stats              # Show today's stats
clawroute stats --week       # This week's stats
clawroute stats --month      # This month's stats
clawroute enable             # Enable routing
clawroute disable            # Disable (passthrough)
clawroute dry-run            # Enable dry-run mode
clawroute live               # Disable dry-run (go live)
clawroute log                # Show recent routing decisions
clawroute config             # Show current config
```

## How Classification Works

ClawRoute uses heuristic rules evaluated in priority order (<5ms, fully local):

### Tier 0: Heartbeat
- Matches: "ping", "hi", "status", "test"
- Short messages (< 30 chars) with no tools
- Routes to: `gemini-2.5-flash-lite` ($0.10/M input)

### Tier 1: Simple
- Acknowledgments: "thanks", "ok", "👍"
- Short questions (< 80 chars)
- Routes to: `deepseek-chat` ($0.28/M input)

### Tier 2: Moderate (default)
- General conversation
- Routes to: `gemini-2.5-flash` ($0.30/M input)

### Tier 3: Complex
- Tool/function calls present
- Analytical keywords + length
- Deep conversations (> 8 messages)
- Routes to: `claude-sonnet-4-6` ($3.00/M input)

### Tier 4: Frontier
- Code blocks detected
- Tool calls with `tool_choice` set
- Very long context (> 8K tokens)
- Routes to: `claude-opus-4-6` ($15/M input) or original model

## Safety Guarantees

### ClawRoute will NEVER break your agent

- **Streaming safety**: Once streaming starts, we're committed. No interruptions, no doubled output.
- **Tool call protection**: Responses with tool calls are NEVER retried (prevents duplicate side effects).
- **Passthrough on error**: Any ClawRoute error → transparent passthrough to original model.
- **Kill switch**: `POST /api/disable` or `CLAWROUTE_ENABLED=false` immediately stops all routing.

### 100% Local & Private

- Classification runs 100% locally (no API calls)
- No content logged by default (`CLAWROUTE_LOG_CONTENT=false`)
- No telemetry, no analytics, no phoning home
- Binds to `127.0.0.1` by default (never exposed to network)

## Supported Providers

| Provider | Status | Models |
|----------|--------|--------|
| OpenAI | ✅ Full | GPT-5 Mini, GPT-5.2, o3 |
| Anthropic | ✅ Full | Claude Sonnet 4.6, Claude Opus 4.6 |
| Google | ✅ Full | Gemini 2.5 Flash Lite, Flash, Pro |
| DeepSeek | ✅ Full | DeepSeek V3.2 (via `deepseek-chat`) |
| OpenRouter | ✅ Full | Any model via OpenRouter |

## Known Limitations

1. **Heuristic classification**: Rules-based, not ML. May occasionally misclassify edge cases.
2. **Token estimates for streaming**: Estimated from chunk count, not exact.
3. **Cost data**: Based on published prices as of Feb 2026, may lag behind provider changes.

## API Reference

### Proxy Endpoints

```
POST /v1/chat/completions  # Main proxy (OpenAI-compatible)
```

### Control Endpoints

```
GET  /health               # Health check
GET  /stats                # Full stats JSON
GET  /dashboard            # Web dashboard
GET  /api/config           # Current config (redacted)
POST /api/enable           # Enable routing
POST /api/disable          # Disable routing
POST /api/dry-run/enable   # Enable dry-run
POST /api/dry-run/disable  # Disable dry-run
POST /api/override/global  # Set global model override
POST /api/override/session # Set session override
```


## FAQ

### Can I use this with Anthropic Claude directly?

Yes! ClawRoute supports Anthropic's API natively. Set `ANTHROPIC_API_KEY` in your `.env` and it will route to Claude models directly. You can also use OpenRouter for additional flexibility.

### Will this break my agent?

No. ClawRoute is designed to fail safe:
- Any internal error → passthrough to original model
- Streaming responses are never interrupted
- Tool calls block retry (no duplicate actions)

### How do I stop ClawRoute?

Multiple options:
1. `curl -X POST http://127.0.0.1:18790/api/disable`
2. Set `CLAWROUTE_ENABLED=false` and restart
3. Remove the `baseUrl` override from OpenClaw config

### Is my data safe?

Yes. ClawRoute is 100% local:
- Classification is heuristic-based (no API calls)
- No content logging by default
- No telemetry or external connections
- All data stays on your machine

## ClawRoute vs OpenRouter

Both solve the "too many LLM providers" problem, but in completely different ways.

| | ClawRoute | OpenRouter |
|---|---|---|
| **Where it runs** | 100% local on your machine | Their cloud servers |
| **Data privacy** | ✅ Prompts never leave your machine | ❌ Routed through OpenRouter's servers |
| **Cost overhead** | Free — pay providers directly | +5.5% platform fee on every request |
| **Smart routing** | ✅ Automatic by complexity (<5ms) | ❌ You pick the model manually |
| **Savings** | 60-90% automatic on simple requests | Only if you manually choose cheaper models |
| **Setup** | Local install + your own API keys | One API key, zero setup |
| **Model access** | Your own keys (5 providers) | 300+ models via one unified key |
| **Works offline** | ✅ Classification is local | ❌ Requires internet |
| **Vendor lock-in** | None — direct provider APIs | Tied to OpenRouter's availability |

**Choose ClawRoute if**: You want automatic cost savings, full privacy, and no middleman fees. You already have API keys.

**Choose OpenRouter if**: You want access to 300+ models with a single key and don't want to manage multiple API accounts.

**Best of both worlds**: Use ClawRoute with `OPENROUTER_API_KEY` — you get ClawRoute's automatic smart routing *and* OpenRouter's model breadth.

## Contributing

Contributions welcome! Please read our contributing guidelines first.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Submit a pull request

## Support the Project

ClawRoute is 100% free and open-source. **There is no billing for LLM usage** within ClawRoute itself—you pay your providers (OpenAI, Anthropic, etc.) directly.

If you find this tool useful, you can optionally support development. The wallet address in the config (`CLAWROUTE_DONATION_USDC_ADDR`) is **strictly for voluntary donations** and is never used for mandatory billing or routing.

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Built with ❤️ by [atharv404](https://github.com/atharv404)
