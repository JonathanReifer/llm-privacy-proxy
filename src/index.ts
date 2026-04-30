import { startProxy } from "./proxy/server.js";

if (!process.env.LLM_PRIVACY_VAULT_KEY) {
  process.stderr.write(
    "\n[llm-privacy-proxy] ERROR: LLM_PRIVACY_VAULT_KEY is not set.\n" +
    "  Run setup.sh to generate keys, then: source ~/.bashrc\n" +
    "  Without this key the vault cannot persist data between sessions.\n\n"
  );
  process.exit(1);
}

startProxy();
