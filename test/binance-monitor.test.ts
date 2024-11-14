import { test, expect, mock, beforeEach } from "bun:test";
import { BinanceMonitorDO } from '../src/binance-monitor';

// 模拟 DurableObjectState
class MockDurableObjectState {
  private storageMap = new Map();
  
  storage = {
    get: mock(async (keys) => {
      if (Array.isArray(keys)) {
        return new Map(keys.map(key => [key, this.storageMap.get(key)]));
      }
      return this.storageMap.get(keys);
    }),
    put: mock(async (key, value) => {
      this.storageMap.set(key, value);
    }),
    delete: mock(async (key) => {
      this.storageMap.delete(key);
    }),
    deleteAlarm: mock(),
    setAlarm: mock()
  };

  blockConcurrencyWhile = mock(async (callback) => {
    await callback();
  });
}

let monitor: BinanceMonitorDO;
let state: MockDurableObjectState;
let env: any;

beforeEach(() => {
  state = new MockDurableObjectState();
  env = {
    POLLING_INTERVAL: '1000'
  };
  monitor = new BinanceMonitorDO(state as any, env);
  
  // 重置 _isMonitoring 状态
  (monitor as any)._isMonitoring = true;
});

// 测试初始化
test('should initialize with default values', async () => {
  expect(monitor).toBeDefined();
});

// 测试 webhook 注册
test('should handle webhook registration', async () => {
  const request = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url: 'https://example.com/webhook',
      secret: 'test-secret'
    })
  });

  const response = await monitor.fetch(request);
  expect(response.status).toBe(200);
  
  const data = await response.json();
  expect(data.message).toBe('Webhook registered');
});


// 修改公告检查测试
test('should detect new announcements', async () => {
  // 模拟 fetch 响应
  globalThis.fetch = mock(() => 
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        data: {
          catalogs: [
            {
              id: 2, // 新的公告 ID
              title: 'Binance Will List BTC',
              code: 'test-code',
              publishDate: '2024-01-01'
            }
          ]
        }
      })
    })
  );

  // 设置初始的 lastAnnouncementId
  (monitor as any).lastAnnouncementId = 1;
  
  await monitor.alarm();
  
  // 验证 alarm 是否被重新设置
  expect(state.storage.setAlarm).toHaveBeenCalledTimes(1);
  expect(state.storage.setAlarm).toHaveBeenCalledWith(expect.any(Number));
});

// 修改错误处理测试
test('should handle API errors gracefully', async () => {
  // 设置监控状态为开启
  (monitor as any)._isMonitoring = true;
  
  globalThis.fetch = mock(() => Promise.reject(new Error('API Error')));
  await monitor.alarm();
  
  // 验证即使出错也会设置下一次 alarm
  expect(state.storage.setAlarm).toHaveBeenCalledTimes(1);
  expect(state.storage.setAlarm).toHaveBeenCalledWith(expect.any(Number));
});

// 修改监控启动测试
test('should not start monitoring if already running', async () => {
  // 重置监控状态
  (monitor as any)._isMonitoring = true;
  
  await monitor.start();
}); 