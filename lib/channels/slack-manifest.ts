/**
 * The Billie app for Slack, as a manifest: in Slack, "Create New App" →
 * "From a manifest", paste this (YAML, or the same as JSON), and every
 * setting Billie needs is in place (docs/slack.md). The addresses are this
 * Billie's own. Slack's rules for each field are in `manifestProblems`, which
 * the tests hold it to (docs.slack.dev/reference/app-manifest).
 */
export type SlackManifest = {
  display_information: { name: string; description: string; background_color: string };
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    bot_user: { display_name: string; always_online: boolean };
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { request_url: string; bot_events: string[] };
    interactivity: { is_enabled: boolean; request_url: string };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
};

export function slackManifestObject(base: string): SlackManifest {
  return {
    display_information: {
      name: "Billie",
      description: "Media10's chat and email assistant. Chats that need a person come here.",
      background_color: "#0d6a5b",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: true,
      },
      // Slack allows only a-z, 0-9, "-", "_" and "." here: the app's name above is what people see.
      bot_user: { display_name: "billie", always_online: true },
    },
    oauth_config: {
      scopes: {
        bot: [
          "chat:write",
          "channels:read",
          "groups:read",
          "channels:history",
          "groups:history",
          "users:read",
          "users:read.email",
          "im:write",
          "reactions:write",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: `${base}/api/webhooks/slack/events`,
        bot_events: ["message.channels", "message.groups"],
      },
      interactivity: { is_enabled: true, request_url: `${base}/api/webhooks/slack/interactions` },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** A value as YAML: quoted when YAML would read it as something else. */
function scalar(v: string | boolean): string {
  if (typeof v === "boolean") return String(v);
  const plain =
    v !== "" &&
    !/^[\s#&*!|>'"%@`{}[\],?:-]/.test(v) &&
    !/: |\s#|\s$/.test(v) &&
    !/^(?:true|false|yes|no|on|off|null|~|[-+]?\d[\d._]*)$/i.test(v);
  return plain ? v : JSON.stringify(v);
}

function yaml(value: object, indent = ""): string {
  return Object.entries(value)
    .map(([key, v]) => {
      if (Array.isArray(v))
        return `${indent}${key}:\n${v.map((x) => `${indent}  - ${scalar(x)}`).join("\n")}`;
      if (v && typeof v === "object") return `${indent}${key}:\n${yaml(v, `${indent}  `)}`;
      return `${indent}${key}: ${scalar(v as string | boolean)}`;
    })
    .join("\n");
}

/** The manifest as YAML (Slack's "YAML" tab). */
export function slackManifest(base: string): string {
  return `${yaml(slackManifestObject(base))}\n`;
}

/** The same manifest as JSON (Slack's "JSON" tab). */
export function slackManifestJson(base: string): string {
  return `${JSON.stringify(slackManifestObject(base), null, 2)}\n`;
}

/**
 * What Slack would refuse in this manifest, by its published rules: an
 * app name up to 35 characters, a description up to 140, a hex colour, a
 * bot name of a-z, 0-9, "-", "_" and "." up to 80, and https addresses.
 */
export function manifestProblems(m: SlackManifest): string[] {
  const problems: string[] = [];
  const d = m.display_information;
  if (!d.name || d.name.length > 35) problems.push("display_information.name: 1 to 35 characters");
  if (d.description.length > 140) problems.push("display_information.description: up to 140");
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(d.background_color))
    problems.push("display_information.background_color: #abc or #aabbcc");
  if (!/^[a-z0-9._-]{1,80}$/.test(m.features.bot_user.display_name))
    problems.push("features.bot_user.display_name: a-z, 0-9, -, _ and . only, up to 80");
  for (const url of [
    m.settings.event_subscriptions.request_url,
    m.settings.interactivity.request_url,
  ])
    if (!/^https:\/\/[^\s/]+\/\S*$/.test(url)) problems.push(`${url}: a full https address`);
  if (m.settings.event_subscriptions.bot_events.length > 100)
    problems.push("bot_events: up to 100");
  if (m.oauth_config.scopes.bot.length > 255) problems.push("scopes.bot: up to 255");
  return problems;
}
