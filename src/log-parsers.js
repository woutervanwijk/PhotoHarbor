// ─────────────────────────────────────────────────────────────────────────────
// Log parser registry
//
// Each parser is an object with:
//   name    String   — unique identifier, must match _type on parsed entries
//   match   (line: string) => bool   — whether this parser handles the line
//   parse   (line: string) => object — returns { _type: name, ...fields }
//                                      or null to fall through to next parser
//   render  (entry: object) => HTMLElement
//
// Register new parsers with registerParser(). They are tried in order; the
// first matching parser wins. Unmatched lines fall back to a raw text entry.
// ─────────────────────────────────────────────────────────────────────────────

// Detect whether the system locale uses 12-hour (AM/PM) or 24-hour time.
// We check once at startup by seeing if the default formatter emits a dayPeriod part.
const SYSTEM_HOUR12 = new Intl.DateTimeFormat(undefined, { hour: "numeric" })
  .formatToParts(new Date())
  .some((p) => p.type === "dayPeriod");

// ── ANSI stripping ────────────────────────────────────────────────────────────

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(s) {
  return s.replace(ANSI_RE, "");
}

// Normalise a raw line coming from the Rust backend:
// strips ANSI codes and the "[err] " / "[out] " prefix we add.
function normalise(raw) {
  return stripAnsi(raw)
    .replace(/^\[err\]\s*/, "")
    .replace(/^\[out\]\s*/, "")
    .trim();
}

// ── Key=value field extraction ────────────────────────────────────────────────

// Matches:   key=value   key="quoted value"
const FIELD_RE = /\b(\w+)=(?:"([^"]*)"|([\S]+))/g;

function extractFields(rest) {
  const fields = [];
  const message = rest
    .replace(FIELD_RE, (_, key, quoted, bare) => {
      fields.push({ key, value: quoted ?? bare });
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { message: message || rest.trim(), fields };
}

// ── Registry ──────────────────────────────────────────────────────────────────

const _parsers = [];

export function registerParser(parser) {
  _parsers.push(parser);
}

// Returns a string key used to detect consecutive duplicate entries.
// Only kei-tracing entries are collapsible; everything else returns null.
export function dedupKey(parsed) {
  if (parsed._type !== "kei-tracing") return null;
  return `${parsed.level}:${parsed.module}:${parsed.message}`;
}

export function parseLine(raw) {
  const line = normalise(raw);
  for (const p of _parsers) {
    if (p.match(line)) {
      const result = p.parse(line);
      if (result) return result;
    }
  }
  return { _type: "raw", text: line || raw };
}

export function renderEntry(parsed) {
  for (const p of _parsers) {
    if (p.name === parsed._type) return p.render(parsed);
  }
  return _renderRaw(parsed.text ?? "");
}

// ── Shared DOM helpers ────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function _renderRaw(text) {
  const row = el("div", "log-entry log-entry--raw");
  row.appendChild(el("span", "log-raw-text", text));
  return row;
}

// Shorten long opaque values (base64 IDs, long paths) for display.
function shortVal(value) {
  if (value.length <= 44) return value;
  // For paths, show only the filename portion.
  const slash = value.lastIndexOf("/");
  if (slash !== -1) return "…/" + value.slice(slash + 1);
  return value.slice(0, 42) + "…";
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser: kei-tracing
//
// Handles lines from Rust's `tracing` crate in the default subscriber format:
//   2026-04-16T12:26:03.467311Z  INFO kei: Starting kei concurrency=10
//   2026-04-16T12:23:24.403268Z  WARN kei::download: Duplicate asset ID ...
// ─────────────────────────────────────────────────────────────────────────────

const TRACING_RE =
  /^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})\.\d+Z)\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+(\S+):\s+(.+)$/;

// Human-readable summaries for common kei messages (exact match).
const MESSAGE_LABELS = {
  "Skipping asset: file exists with same name and size": "Already on disk, skipping",
  "Duplicate asset ID from API, skipping": "Duplicate asset ID, skipped",
  "Authentication completed successfully": "Authenticated",
  "Download config changed since last sync, clearing sync tokens": "Config changed — clearing sync tokens",
  "Download config changed since last sync, verifying all files": "Config changed — verifying all files",
  "No sync token found, performing full enumeration": "No sync token — full enumeration",
  "Reset failed assets for retry": "Retrying previously failed assets",
  "Cleaned up orphaned .part files": "Cleaned up partial downloads",
  "No new photos to download from incremental sync": "No new photos to download",
  "Assets to download from incremental sync": "Assets to download",
  "Downloading files from incremental sync": "Downloading files",
  "sync results": "Sync results",
  "completed": "Sync complete",
  "── Incremental Sync Summary ──": "Incremental Sync Summary",
};

// Prefix-based labels for messages whose text includes a variable number/value.
const MESSAGE_PREFIX_LABELS = [
  ["Incremental sync:", "Incremental sync"],
  ["File header does not match expected format for ", "Unrecognized file format, saving anyway"],
];

function resolveLabel(msg) {
  if (MESSAGE_LABELS[msg]) return MESSAGE_LABELS[msg];
  for (const [prefix, label] of MESSAGE_PREFIX_LABELS) {
    if (msg.startsWith(prefix)) return label;
  }
  return msg;
}

registerParser({
  name: "kei-tracing",

  match: (line) => TRACING_RE.test(line),

  parse(line) {
    const m = line.match(TRACING_RE);
    if (!m) return null;
    const [, timestamp, , level, module, rest] = m;
    const { message, fields } = extractFields(rest);
    const localTime = new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: SYSTEM_HOUR12,
    });
    return { _type: "kei-tracing", timestamp, time: localTime, level, module, message, fields };
  },

  render(entry) {
    const lvl = entry.level.toLowerCase();
    const row = el("div", `log-entry log-entry--${lvl}`);

    // Level badge
    row.appendChild(el("span", `log-level log-level--${lvl}`, entry.level));

    // Body: message + fields
    const body = el("div", "log-body");

    const displayMsg = resolveLabel(entry.message);
    body.appendChild(el("span", "log-message", displayMsg));

    if (entry.fields.length > 0) {
      const fieldsRow = el("div", "log-fields");
      for (const { key, value } of entry.fields) {
        const chip = el("span", "log-field");
        chip.appendChild(el("span", "log-field-key", key));
        chip.appendChild(el("span", "log-field-sep", "="));
        chip.appendChild(el("span", "log-field-val", shortVal(value)));
        fieldsRow.appendChild(chip);
      }
      body.appendChild(fieldsRow);
    }

    row.appendChild(body);

    // Count badge — hidden until dedup logic increments it
    row.appendChild(el("span", "log-count hidden", ""));

    // Meta: module + time (right side)
    const meta = el("div", "log-meta");
    meta.appendChild(el("span", "log-module", entry.module));
    const timeEl = el("span", "log-time", entry.time);
    timeEl.dataset.role = "time";
    meta.appendChild(timeEl);
    row.appendChild(meta);

    return row;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Parser: kei-command
//
// Handles shell command lines emitted by the app before each kei invocation:
//   $ /long/path/to/kei sync -a all
//   $ /long/path/to/kei list albums
// Strips the binary path to just "kei" and renders each arg as a chip.
// ─────────────────────────────────────────────────────────────────────────────

registerParser({
  name: "kei-command",

  match: (line) => line.startsWith("$ "),

  parse(line) {
    const parts = line.slice(2).trim().split(/\s+/);
    // Replace the full binary path with just the filename ("kei").
    const bin = parts[0].replace(/.*[\\/]/, "");
    const args = parts.slice(1);
    return { _type: "kei-command", bin, args };
  },

  render(entry) {
    const row = el("div", "log-entry log-entry--command");
    const prompt = el("span", "log-cmd-prompt", "$");
    const bin = el("span", "log-cmd-bin", entry.bin);
    row.appendChild(prompt);
    row.appendChild(bin);
    for (const arg of entry.args) {
      row.appendChild(el("span", "log-cmd-arg", arg));
    }
    return row;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Parser: kei-summary
//
// Handles the plain-text summary lines kei prints at the end of a run:
//   sync results: 42 downloaded, 0 failed, 7392 total
//   completed: 3m 22s
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_RE = /^──\s+(.+?)\s+──$|^(sync results:|completed:)\s+(.+)$/i;

registerParser({
  name: "kei-summary",

  match: (line) => SUMMARY_RE.test(line) || line.startsWith("──"),

  parse(line) {
    return { _type: "kei-summary", text: line };
  },

  render(entry) {
    const row = el("div", "log-entry log-entry--summary");
    row.appendChild(el("span", "log-summary-text", entry.text));
    return row;
  },
});
