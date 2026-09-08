import type { DeviceControlRouter } from "./device-control-router.ts";

export interface DeviceCommandResult {
  handled: boolean;
  reply?: string;
}

function describeDevices(devices: ReturnType<DeviceControlRouter["list"]>): string {
  if (devices.length === 0) return "目前没有已连接的客户端设备";
  return [
    "在线客户端：",
    ...devices.map((device) => {
      const granted = device.capabilities.filter((item) => item.granted).map((item) => item.id).join("、");
      return `${device.name}（${device.id.slice(0, 8)}，${device.platform}/${device.arch}）可用：${granted || "仅连接"}`;
    }),
  ].join("\n");
}

export async function handleDeviceCommand(text: string, devices: DeviceControlRouter): Promise<DeviceCommandResult> {
  const normalized = text.trim();
  if (normalized === "/devices" || /^(?:现在)?(?:有|都有哪些|哪些).{0,5}(?:客户端|设备)(?:在线|连着|连接)?[？?]?$/u.test(normalized)) {
    return { handled: true, reply: describeDevices(devices.list()) };
  }

  const info = /^\/device\s+info\s+(\S+)$/iu.exec(normalized);
  if (info) {
    try {
      const device = devices.resolve(info[1]);
      const output = await devices.execute(device.id, "device.info") as Record<string, unknown>;
      return { handled: true, reply: `${device.name}：${output.platform ?? device.platform}/${output.arch ?? device.arch}，客户端 ${output.appVersion ?? device.appVersion}，主机 ${output.hostname ?? "未知"}` };
    } catch (error) {
      return { handled: true, reply: `设备信息读取失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const open = /^\/device\s+open\s+(\S+)\s+(https?:\/\/\S+)$/iu.exec(normalized);
  if (open) {
    try {
      const device = devices.resolve(open[1]);
      await devices.execute(device.id, "url.open", { url: open[2] });
      return { handled: true, reply: `已经让 ${device.name} 打开这个网页` };
    } catch (error) {
      return { handled: true, reply: `没能打开网页：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const copy = /^\/device\s+copy\s+(\S+)\s+(.+)$/isu.exec(normalized);
  if (copy) {
    try {
      const device = devices.resolve(copy[1]);
      await devices.execute(device.id, "clipboard.write", { text: copy[2] });
      return { handled: true, reply: `已经复制到 ${device.name} 的剪贴板` };
    } catch (error) {
      return { handled: true, reply: `没能写入剪贴板：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const notify = /^\/device\s+notify\s+(\S+)\s+(.+)$/isu.exec(normalized);
  if (notify) {
    try {
      const device = devices.resolve(notify[1]);
      await devices.execute(device.id, "notification.show", { title: "艾米莉亚", body: notify[2] });
      return { handled: true, reply: `通知已经显示在 ${device.name}` };
    } catch (error) {
      return { handled: true, reply: `没能显示通知：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return { handled: false };
}
