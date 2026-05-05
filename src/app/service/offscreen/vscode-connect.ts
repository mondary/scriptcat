import LoggerCore from "@App/app/logger/core";
import Logger from "@App/app/logger/logger";
import { type Group } from "@Packages/message/server";
import type { MessageSend } from "@Packages/message/types";
import { ScriptClient } from "../service_worker/client";
import { v5 as uuidv5 } from "uuid";
import type { ScriptAndCode } from "@App/app/repo/scripts";

// 在offscreen下与scriptcat-vscode建立websocket连接
// 需要在vscode中安装scriptcat-vscode插件
export class VSCodeConnect {
  logger: Logger = LoggerCore.logger().with({ service: "VSCodeConnect" });

  reconnect: boolean = false;

  wsConnect: WebSocket | undefined;

  connectVSCodeTimer: any;
  syncTimer: any;
  knownScripts: Map<string, string> = new Map();

  scriptClient: ScriptClient;

  constructor(
    private group: Group,
    private msgSender: MessageSend
  ) {
    this.scriptClient = new ScriptClient(this.msgSender);
  }

  connect({ url, reconnect }: { url: string; reconnect: boolean }) {
    // 如果已经连接，断开重连
    if (this.wsConnect) {
      this.wsConnect.close();
    }
    // 清理老的定时器
    if (this.connectVSCodeTimer) {
      clearInterval(this.connectVSCodeTimer);
      this.connectVSCodeTimer = undefined;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    const handler = () => {
      if (!this.wsConnect) {
        return this.connectVSCode({ url });
      }
      return Promise.resolve();
    };
    if (reconnect) {
      this.connectVSCodeTimer = setInterval(() => {
        handler();
      }, 30 * 1000);
    }
    return handler();
  }

  // 连接到vscode
  connectVSCode({ url }: { url: string }) {
    return new Promise<void>((resolve, reject) => {
      // 如果已经连接，断开重连
      if (this.wsConnect) {
        this.wsConnect.close();
      }
      try {
        this.wsConnect = new WebSocket(url);
      } catch (e: any) {
        this.logger.debug("connect vscode faild", Logger.E(e));
        reject(e);
        return;
      }
      let ok = false;
      this.wsConnect.addEventListener("open", () => {
        this.wsConnect!.send('{"action":"hello"}');
        this.sendAllScripts();
        this.startPeriodicSync();
        ok = true;
        resolve();
      });
      this.wsConnect.addEventListener("message", async (ev) => {
        const data = JSON.parse(ev.data);
        switch (data.action || data.type) {
          case "onchange": {
            const code = data.data.script;
            this.scriptClient.installByCode(uuidv5(data.data.uri, uuidv5.URL), code, "vscode");
            break;
          }
          case "sync_all": {
            await this.sendAllScripts();
            break;
          }
          case "script_list": {
            await this.applyScriptList(data.data || []);
            break;
          }
          case "script_update": {
            await this.applyScriptUpdate(data.data?.script);
            break;
          }
          case "script_delete": {
            await this.applyScriptDelete(data.data?.scriptId);
            break;
          }
          default:
        }
      });

      this.wsConnect.addEventListener("error", (e) => {
        this.wsConnect = undefined;
        this.logger.debug("connect vscode faild", Logger.E(e));
        if (!ok) {
          reject(new Error("connect fail"));
        }
      });

      this.wsConnect.addEventListener("close", () => {
        this.wsConnect = undefined;
        if (this.syncTimer) {
          clearInterval(this.syncTimer);
          this.syncTimer = undefined;
        }
        this.logger.debug("vscode connection closed");
      });
    });
  }

  toTransport(script: ScriptAndCode) {
    return {
      id: script.uuid,
      name: script.name,
      code: script.code || "",
      meta: script.metadata || {},
      updated: script.updatetime || script.createtime || Date.now(),
    };
  }

  async sendAllScripts() {
    if (!this.wsConnect || this.wsConnect.readyState !== WebSocket.OPEN) return;
    const scripts = await this.scriptClient.getAllScriptsWithCode();
    const list = scripts.map((s) => this.toTransport(s));
    this.knownScripts.clear();
    list.forEach((s) => this.knownScripts.set(s.id, s.code));
    this.wsConnect.send(
      JSON.stringify({
        type: "script_list",
        data: list,
        timestamp: Date.now(),
      })
    );
  }

  async syncDiff() {
    if (!this.wsConnect || this.wsConnect.readyState !== WebSocket.OPEN) return;
    const scripts = await this.scriptClient.getAllScriptsWithCode();
    const current = new Map<string, string>();
    scripts.forEach((s) => current.set(s.uuid, s.code || ""));

    for (const script of scripts) {
      const knownCode = this.knownScripts.get(script.uuid);
      if (knownCode !== (script.code || "")) {
        this.wsConnect.send(
          JSON.stringify({
            type: "script_update",
            data: { script: this.toTransport(script) },
            timestamp: Date.now(),
          })
        );
      }
    }

    for (const scriptId of this.knownScripts.keys()) {
      if (!current.has(scriptId)) {
        this.wsConnect.send(
          JSON.stringify({
            type: "script_delete",
            data: { scriptId },
            timestamp: Date.now(),
          })
        );
      }
    }

    this.knownScripts = current;
  }

  startPeriodicSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    this.syncTimer = setInterval(() => {
      this.syncDiff().catch((e) => this.logger.debug("sync diff error", Logger.E(e)));
    }, 5000);
  }

  normalizeIncomingId(script: any): string {
    if (script?.id) return String(script.id);
    if (script?.name) return uuidv5(`script:${script.name}`, uuidv5.URL);
    return uuidv5(`script:${Date.now()}`, uuidv5.URL);
  }

  async applyScriptUpdate(script: any) {
    if (!script?.code) return;
    const id = this.normalizeIncomingId(script);
    await this.scriptClient.installByCode(id, script.code, "vscode");
  }

  async applyScriptDelete(scriptId: string) {
    if (!scriptId) return;
    await this.scriptClient.deletes([scriptId]);
  }

  async applyScriptList(items: any[]) {
    for (const item of items) {
      if (item?.code) {
        const id = this.normalizeIncomingId(item);
        await this.scriptClient.installByCode(id, item.code, "vscode");
      }
    }
  }

  init() {
    this.group.on("connect", this.connect.bind(this));
  }
}
