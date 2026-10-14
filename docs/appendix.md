# Appendix

Disclaimer lives in the README; this file covers the standalone local service that ships in the same repository.

> 本文件内容取自原 README，正文与原句一致；仅调整标题层级与相对路径。

---

### The standalone local service (in development)

The repository now offers two entry points: what the install section above sets up is the **DSH plugin**; `packages/standalone` is a **standalone local service that needs no DSH installed**. Run it from a full source checkout:

```powershell
npm run start:standalone
```

The standalone service uses `~/.our-free-model` and port `18900` by default, has its own API key, and does not read the plugin's data. It supports the anonymous/Kilo channels, the EAC lane and the same thirteen account channels, exposes Chat Completions and the Responses API, and ships its own web management pages (models, statistics, channels, EAC, settings, API key). Open the one-time management link printed in the terminal to use it; accounts sign in on the standalone pages, and a plugin account backup can also be imported by hand.

Startup, arguments and verification are covered in [the standalone service README](../packages/standalone/README.md). Install artifacts and a Release for the standalone service are not published yet.

---

Back to [README](../README_EN.md)
