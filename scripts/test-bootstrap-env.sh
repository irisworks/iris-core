#!/usr/bin/env bash
# Regression checks for bootstrap's non-interactive environment inputs.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bootstrap="${repo_dir}/bootstrap.sh"

# Load only bootstrap's setup and prompt helpers.  Running the complete script
# would install packages and create services, neither of which a unit test may
# do.  The marker is deliberately a stable section boundary, immediately before
# argument parsing and all operational side effects.
preamble="$(sed '/^# Parse args$/q' "${bootstrap}")"

run_helper_test() {
  local output
  output="$(IRIS_DIR=/iris-staging ANTHROPIC_API_KEY=anthropic-from-env \
    bash -c "${preamble}
      [[ \"\${IRIS_DIR}\" == /iris-staging ]]
      [[ \"\${ENV_ANTHROPIC_API_KEY}\" == anthropic-from-env ]]
      prompt_secret 'Anthropic API key' '' \"\${ENV_ANTHROPIC_API_KEY}\"" 2>/dev/null)"
  [[ "${output}" == "anthropic-from-env" ]]
}

run_helper_test

# Keep each production call wired to its captured environment value.  These
# assertions cover the provider and integration paths without exposing values.
for expected in \
  'IRIS_DIR="${IRIS_DIR:-/iris}"' \
  '"$ENV_ANTHROPIC_API_KEY"' \
  '"$ENV_OPENAI_API_KEY"' \
  '"$ENV_AZURE_FOUNDRY_KEY"' \
  '"$ENV_DEEPSEEK_API_KEY"' \
  '"$ENV_MISTRAL_API_KEY"' \
  '"$ENV_CUSTOM_API_KEY"' \
  '"$ENV_AWS_ACCESS_KEY_ID"' \
  '"$ENV_IRIS_SLACK_APP_TOKEN"' \
  '"$ENV_TELEGRAM_BOT_TOKEN"' \
  '"$ENV_GITHUB_TOKEN"' \
  '"$ENV_RESEND_API_KEY"' \
  '"$ENV_PERPLEXITY_API_KEY"'; do
  grep -Fq "${expected}" "${bootstrap}"
done

echo "bootstrap environment-input regression checks passed"
