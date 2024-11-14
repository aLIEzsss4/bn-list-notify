import { Env } from "./types";

interface Webhook {
  secret: string;
  url: string;
}

type Announcement = {
  id: number;
  title: string;
  code: string;
  publishDate: string;
};

export class BinanceMonitorDO {
  private webhooks: Webhook[] = [];
  private watchList: string[] = [];
  private lastAnnouncementId: number | null = null;
  private _isMonitoring: boolean = false;
  private state: DurableObjectState;
  private env: Env;
  private readonly pollingInterval: number;

  private readonly BINANCE_API =
    "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query";

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.pollingInterval = parseInt(env.POLLING_INTERVAL) || 3000;

    // 从存储中恢复状态
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get([
        "webhooks",
        "lastAnnouncementId",
        "isMonitoring",
        "watchList",
      ]);
      this.webhooks = (stored.get("webhooks") as Webhook[]) || [];
      this.lastAnnouncementId =
        (stored.get("lastAnnouncementId") as number) || null;
      this._isMonitoring = (stored.get("isMonitoring") as boolean) || false;
      this.watchList = (stored.get("watchList") as string[]) || [];

      if (this._isMonitoring) {
        await this.state.storage.setAlarm(Date.now() + this.pollingInterval);
      }
    });

    console.log("BinanceMonitorDO initialized");
  }

  async fetchAnnouncements(): Promise<Announcement[]> {
    try {
      const params = new URLSearchParams({
        type: "1",
        catalogId: "48",
        pageNo: "1",
        pageSize: "20",
      });

      const response = await fetch(`${this.BINANCE_API}?${params}`);
      if (!response.ok) throw new Error("Failed to fetch announcements");

      const data = await response.json();
      return data?.data?.catalogs || [];
    } catch (error) {
      console.error("Error fetching announcements:", error);
      return [];
    }
  }

  private getAnnouncementUrl(title: string, code: string): string {
    // 使用 encodeURIComponent 对中文标题进行编码
    const encodedTitle = encodeURIComponent(title);
    return `https://www.binance.com/zh-CN/support/announcement/${encodedTitle}-${code}`;
  }

  private extractAnnouncementCode(url: string): string {
    // 从完整URL中提取最后的code部分
    const matches = url.match(/([^\/]+)$/);
    return matches ? matches[0] : "";
  }

  async notifyWebhooks(announcement: Announcement) {
    const announcementUrl = this.getAnnouncementUrl(
      announcement.title,
      this.extractAnnouncementCode(announcement.code)
    );

    const payload = {
      timestamp: new Date().toISOString(),
      announcement: {
        title: announcement.title,
        code: announcement.code,
        url: announcementUrl,
        publishDate: announcement.publishDate,
      },
    };

    const notifications = this.webhooks.map(async (webhook) => {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (webhook.secret) {
          headers["X-Webhook-Secret"] = webhook.secret;
        }

        const response = await fetch(webhook.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(
            `Webhook notification failed: ${response.statusText}`
          );
        }
      } catch (error) {
        console.error(`Failed to notify webhook ${webhook.url}:`, error);
      }
    });

    await Promise.all(notifications);
  }

  async start() {
    if (this._isMonitoring) return;

    this._isMonitoring = true;
    await this.state.storage.put("isMonitoring", true);
    await this.state.storage.setAlarm(Date.now() + this.pollingInterval);
  }

  async stop() {
    this._isMonitoring = false;
    await this.state.storage.put("isMonitoring", false);
    await this.state.storage.deleteAlarm();
  }

  async alarm() {
    try {
      const announcements = await this.fetchAnnouncements();
      if (!announcements.length) {
        if (this._isMonitoring) {
          await this.state.storage.setAlarm(Date.now() + this.pollingInterval);
        }
        return;
      }

      const latestId = announcements[0].id;

      if (this.lastAnnouncementId === null) {
        this.lastAnnouncementId = latestId;
        await this.state.storage.put("lastAnnouncementId", latestId);
      } else if (latestId !== this.lastAnnouncementId) {
        for (const announcement of announcements) {
          if (announcement.id === this.lastAnnouncementId) break;

          const title = announcement.title;
          if (title.includes("Binance Will List")) {
            await this.notifyWebhooks(announcement);
          }
        }
        this.lastAnnouncementId = latestId;
        await this.state.storage.put("lastAnnouncementId", latestId);
      }
    } catch (error) {
      console.error("Error in monitoring alarm:", error);
    } finally {
      if (this._isMonitoring) {
        await this.state.storage.setAlarm(Date.now() + this.pollingInterval);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (request.method) {
      case "POST":
        if (url.pathname === "/webhook") {
          const { url: webhookUrl, secret } = await request.json();
          this.webhooks.push({ url: webhookUrl, secret });
          await this.state.storage.put("webhooks", this.webhooks);
          return new Response(
            JSON.stringify({
              message: "Webhook registered",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (url.pathname === "/watch") {
          const { coins } = await request.json();
          if (!Array.isArray(coins)) {
            return new Response("Invalid request: coins must be an array", {
              status: 400,
            });
          }
          this.watchList = coins;
          await this.state.storage.put("watchList", this.watchList);
          return new Response(
            JSON.stringify({
              message: "Watch list updated",
              watchList: this.watchList,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (url.pathname === "/start") {
          await this.start();
          return new Response(
            JSON.stringify({
              message: "Monitoring started",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (url.pathname === "/stop") {
          await this.stop();
          return new Response(
            JSON.stringify({
              message: "Monitoring stopped",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        break;

      case "GET":
        if (url.pathname === "/webhooks") {
          return new Response(
            JSON.stringify({
              webhooks: this.webhooks,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (url.pathname === "/watch") {
          return new Response(
            JSON.stringify({
              watchList: this.watchList,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        break;

      case "DELETE":
        if (url.pathname.startsWith("/webhook/")) {
          const urlToDelete = decodeURIComponent(url.pathname.slice(9));
          this.webhooks = this.webhooks.filter((w) => w.url !== urlToDelete);
          await this.state.storage.put("webhooks", this.webhooks);
          return new Response(
            JSON.stringify({
              message: "Webhook deleted",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (url.pathname === "/watch") {
          this.watchList = [];
          await this.state.storage.put("watchList", this.watchList);
          return new Response(
            JSON.stringify({
              message: "Watch list cleared",
              watchList: this.watchList,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        break;
    }

    return new Response("Not found", { status: 404 });
  }
}
