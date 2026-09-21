import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  UsersPersonalFileGetResult,
  UsersPersonalFileSetResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { renderSettingsEmpty, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderSettingsSelectRow } from "../config/settings-select-row.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../config/settings-targets.ts";

export class PersonalInstructions extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state() private agentId = "";
  @state() private file: UsersPersonalFileGetResult | null = null;
  @state() private draft = "";
  @state() private busy: "load" | "save" | null = null;
  @state() private error: string | null = null;
  @state() private saved = false;
  private client: GatewayBrowserClient | null = null;
  private profileId: string | null = null;
  private connectionId: string | null = null;
  private gatewayUrl: string | null = null;
  private available = false;
  private generation = 0;
  private subscriptions: Array<() => void> = [];

  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe(() => this.syncContext()),
      this.context.agents.subscribe(() => this.syncContext()),
    ];
    this.syncContext();
    void this.context.agents.ensureList();
  }

  override disconnectedCallback() {
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions = [];
    this.generation += 1;
    this.client = null;
    this.available = false;
    super.disconnectedCallback();
  }

  private get agents() {
    return this.context.agents.state?.agentsList?.agents ?? [];
  }

  private get dirty() {
    return this.file !== null && this.draft !== this.file.content;
  }

  private syncContext() {
    const snapshot = this.context.gateway.snapshot;
    const connected = snapshot.phase === "connected";
    // Hello can arrive before profile resolution. Keep the draft private until
    // identity is known, then restore it only for the same person and Gateway.
    // A reconnect keeps the old hash so concurrent edits still conflict.
    const profileId = snapshot.selfUser?.id ?? this.profileId;
    const gatewayUrl = this.context.gateway.connection.gatewayUrl;
    const connectionId = snapshot.hello?.server?.connId ?? null;
    const available =
      connected &&
      Boolean(snapshot.selfUser?.id) &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    const identityChanged = profileId !== this.profileId || gatewayUrl !== this.gatewayUrl;
    const sourceChanged =
      identityChanged ||
      snapshot.client !== this.client ||
      connectionId !== this.connectionId ||
      available !== this.available;
    if (sourceChanged) {
      this.generation += 1;
      this.client = snapshot.client;
      this.connectionId = connectionId;
      this.gatewayUrl = gatewayUrl;
      this.profileId = profileId;
      this.available = available;
      this.busy = null;
      this.error = null;
      this.saved = false;
      if (identityChanged) {
        this.file = null;
        this.draft = "";
        this.agentId = "";
      }
    }
    // Never retarget an existing editor if its agent disappears from the catalog.
    let selectedAgent = false;
    if (!this.agentId && this.agents.length) {
      const defaultId = this.context.agents.state.agentsList?.defaultId;
      this.agentId =
        this.agents.find((agent) => agent.id === defaultId)?.id ?? this.agents[0]?.id ?? "";
      selectedAgent = true;
    }
    if (this.available && this.agentId && !this.dirty && (sourceChanged || selectedAgent)) {
      void this.load();
    }
    this.requestUpdate();
  }

  private async load() {
    const client = this.client;
    const agentId = this.agentId;
    const profileId = this.profileId;
    if (!client || !this.available || !agentId || this.busy) {
      return;
    }
    const generation = ++this.generation;
    this.busy = "load";
    this.error = null;
    this.saved = false;
    try {
      const file = await client.request<UsersPersonalFileGetResult>("users.personalFile.get", {
        agentId,
      });
      if (generation !== this.generation) {
        return;
      }
      if (file.agentId !== agentId || file.profileId !== profileId) {
        throw new Error(t("profilePage.personalInstructions.contextChanged"));
      }
      this.file = file;
      this.draft = file.content;
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.busy = null;
      }
    }
  }

  private async save() {
    const client = this.client;
    const file = this.file;
    if (
      !client ||
      !file ||
      !this.available ||
      this.busy ||
      !this.dirty ||
      this.draft.length > 4000 ||
      !this.agents.some((agent) => agent.id === file.agentId)
    ) {
      return;
    }
    const generation = ++this.generation;
    const content = this.draft;
    this.busy = "save";
    this.error = null;
    this.saved = false;
    try {
      const result = await client.request<UsersPersonalFileSetResult>("users.personalFile.set", {
        agentId: file.agentId,
        content,
        expectedHash: file.hash,
      });
      if (generation !== this.generation) {
        return;
      }
      if (result.agentId !== file.agentId || result.profileId !== file.profileId) {
        throw new Error(t("profilePage.personalInstructions.contextChanged"));
      }
      this.file = result;
      this.draft = result.content;
      this.saved = true;
    } catch (error) {
      if (generation === this.generation) {
        this.error = formatUiError(error);
      }
    } finally {
      if (generation === this.generation) {
        this.busy = null;
      }
    }
  }

  private reload() {
    if (this.dirty && !window.confirm(t("profilePage.personalInstructions.discard"))) {
      return;
    }
    void this.load();
  }

  override render() {
    return html`<div id=${PROFILE_SETTINGS_TARGET_IDS.personalInstructions}>
      ${renderSettingsSection(
        {
          title: t("profilePage.personalInstructions.title"),
          description: t("profilePage.personalInstructions.description"),
        },
        !this.available
          ? renderSettingsEmpty(t("profilePage.personalInstructions.signIn"))
          : !this.agents.length
            ? renderSettingsEmpty(t("profilePage.personalInstructions.noAgents"))
            : html`
                ${renderSettingsSelectRow({
                  title: t("profilePage.personalInstructions.agent"),
                  value: this.agentId,
                  options: this.agents.map((agent) => ({
                    value: agent.id,
                    label: agent.name || agent.id,
                  })),
                  disabled: this.busy !== null,
                  onChange: (agentId) => {
                    if (
                      agentId === this.agentId ||
                      !this.agents.some((agent) => agent.id === agentId)
                    ) {
                      return;
                    }
                    if (
                      this.dirty &&
                      !window.confirm(t("profilePage.personalInstructions.discard"))
                    ) {
                      const select = this.querySelector("select");
                      if (select) {
                        select.value = this.agentId;
                      }
                      return;
                    }
                    this.generation += 1;
                    this.agentId = agentId;
                    this.file = null;
                    this.draft = "";
                    void this.load();
                  },
                })}
                <div class="personal-instructions">
                  ${
                    this.file
                      ? html`
                          <label
                            class="personal-instructions__label"
                            for="personal-instructions-content"
                            >${t("profilePage.personalInstructions.title")}</label
                          >
                          <textarea
                            id="personal-instructions-content"
                            class="settings-input personal-instructions__editor"
                            rows="7"
                            .value=${this.draft}
                            ?disabled=${this.busy !== null}
                            aria-describedby="personal-instructions-guidance"
                            @input=${(event: Event) => {
                              if (!(event.currentTarget instanceof HTMLTextAreaElement)) {
                                return;
                              }
                              this.draft = event.currentTarget.value;
                              this.saved = false;
                            }}
                          ></textarea>
                          <div id="personal-instructions-guidance" class="settings-row__desc">
                            ${t("profilePage.personalInstructions.guidance", { count: String(this.draft.length) })}
                            ${this.file.missing ? t("profilePage.personalInstructions.missing") : nothing}
                          </div>
                          ${this.draft.length > 4000 ? html`<div role="alert">${t("profilePage.personalInstructions.tooLong")}</div>` : nothing}
                        `
                      : nothing
                  }
                  ${this.error ? html`<div class="personal-instructions__error" role="alert">${this.error} ${t("profilePage.personalInstructions.failureHint")}</div>` : nothing}
                  <div class="personal-instructions__actions">
                    <button
                      class="btn"
                      ?disabled=${!this.file || !this.dirty || this.busy !== null || this.draft.length > 4000 || !this.agents.some((agent) => agent.id === this.agentId)}
                      @click=${() => void this.save()}
                    >
                      ${this.busy === "save" ? t("common.saving") : t("common.save")}
                    </button>
                    <button
                      class="btn"
                      ?disabled=${this.busy !== null}
                      @click=${() => this.reload()}
                    >
                      ${this.busy === "load" ? t("common.loading") : t("profilePage.personalInstructions.reload")}
                    </button>
                    <span class="settings-row__desc" role="status"
                      >${this.dirty ? t("profilePage.personalInstructions.dirty") : this.saved ? t("profilePage.personalInstructions.saved") : nothing}</span
                    >
                  </div>
                </div>
              `,
      )}
    </div>`;
  }
}

if (!customElements.get("openclaw-personal-instructions")) {
  customElements.define("openclaw-personal-instructions", PersonalInstructions);
}
