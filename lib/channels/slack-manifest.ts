/**
 * The Billie app for Slack, as a manifest: in Slack, "Create an app" →
 * "From a manifest", paste this, and every setting Billie needs is in place
 * (docs/slack.md). The addresses are this Billie's own.
 */
export function slackManifest(base: string): string {
  return `display_information:
  name: Billie
  description: Media10's chat and email assistant. Chats that need a person come here.
  background_color: "#0d6a5b"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: true
  bot_user:
    display_name: Billie
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:read
      - groups:read
      - channels:history
      - groups:history
      - users:read
      - users:read.email
      - im:write
      - reactions:write
settings:
  event_subscriptions:
    request_url: ${base}/api/webhooks/slack/events
    bot_events:
      - message.channels
      - message.groups
  interactivity:
    is_enabled: true
    request_url: ${base}/api/webhooks/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
}
