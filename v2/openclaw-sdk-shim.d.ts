declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginApi = import("./src/sdk.js").PluginApi;
}
