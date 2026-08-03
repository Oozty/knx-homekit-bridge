'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const YAML = require('yaml');
const knx = require('knx');
const qrcode = require('qrcode-terminal');
const hap = require('hap-nodejs');

const {
  Accessory,
  Bridge,
  Categories,
  Characteristic,
  Service,
  uuid,
  HAPStorage,
} = hap;

const APP_DIR = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(APP_DIR, 'config.yml');
const STORAGE_PATH = path.join(APP_DIR, 'homekit-data');
const VERSION = '0.1.0';

function log(message) {
  console.log(`[${new Date().toLocaleString('tr-TR')}] ${message}`);
}

function fail(message, error) {
  console.error(`\nHATA: ${message}`);
  if (error) console.error(error.stack || error.message || error);
  console.error('\nPencereyi kapatmak için Enter tuşuna basın.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.yml bulunamadı: ${CONFIG_PATH}`);
  }
  const config = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!config || !config.knx || !config.homekit) {
    throw new Error('config.yml içinde knx ve homekit bölümleri bulunmalıdır.');
  }
  if (!Array.isArray(config.accessories)) config.accessories = [];
  return config;
}

function localIPv4() {
  const result = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

function discoverGateways(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    const packet = Buffer.from([
      0x06, 0x10, 0x02, 0x01, 0x00, 0x0e,
      0x08, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    socket.on('error', reject);
    socket.on('message', (msg, remote) => {
      if (msg.length < 6 || msg[2] !== 0x02 || msg[3] !== 0x02) return;
      const key = `${remote.address}:${remote.port}`;
      if (!found.has(key)) {
        found.set(key, { address: remote.address, port: remote.port });
        log(`KNX/IP cihazı bulundu: ${key}`);
      }
    });

    socket.bind(0, '0.0.0.0', () => {
      socket.setBroadcast(true);
      try { socket.setMulticastTTL(4); } catch (_) {}
      socket.send(packet, 3671, '224.0.23.12');
      socket.send(packet, 3671, '255.255.255.255');
      log('KNX/IP cihazları aranıyor (yaklaşık 6 saniye)...');
    });

    setTimeout(() => {
      socket.close();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

function normalizeBool(value) {
  if (Buffer.isBuffer(value)) return value.length > 0 && value[value.length - 1] !== 0;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeNumber(value) {
  if (typeof value === 'number') return value;
  if (Buffer.isBuffer(value)) {
    if (value.length === 1) return value[0];
    return Number.NaN;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

class KnxBus {
  constructor(config) {
    this.config = config;
    this.connection = null;
    this.listeners = new Map();
  }

  subscribe(address, callback) {
    if (!address) return;
    if (!this.listeners.has(address)) this.listeners.set(address, []);
    this.listeners.get(address).push(callback);
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) reject(new Error('KNX/IP bağlantısı zaman aşımına uğradı.'));
      }, 15000);

      this.connection = new knx.Connection({
        ipAddr: this.config.gatewayIp,
        ipPort: Number(this.config.gatewayPort || 3671),
        physAddr: this.config.physicalAddress || '1.1.250',
        minimumDelay: 20,
        handlers: {
          connected: () => {
            settled = true;
            clearTimeout(timeout);
            log(`KNX/IP bağlantısı kuruldu: ${this.config.gatewayIp}:${this.config.gatewayPort || 3671}`);
            resolve();
          },
          event: (event, source, destination, value) => {
            const callbacks = this.listeners.get(destination) || [];
            callbacks.forEach((callback) => {
              try { callback(value, event, source); } catch (error) { console.error(error); }
            });
          },
          error: (status) => {
            log(`KNX bağlantı uyarısı: ${status}`);
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(new Error(String(status)));
            }
          },
        },
      });
    });
  }

  write(address, value, dpt) {
    if (!address) return;
    log(`KNX yaz: ${address} = ${value} (${dpt})`);
    this.connection.write(address, value, dpt);
  }

  read(address) {
    if (!address) return;
    try { this.connection.read(address); } catch (error) { log(`KNX okuma hatası ${address}: ${error.message}`); }
  }
}

function setAccessoryInfo(accessory, item) {
  accessory.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, 'KNX Bridge Pro')
    .setCharacteristic(Characteristic.Model, item.type)
    .setCharacteristic(Characteristic.SerialNumber, item.id)
    .setCharacteristic(Characteristic.FirmwareRevision, VERSION);
}

function createSwitch(item, bus) {
  const accessory = new Accessory(item.name, uuid.generate(`knx:${item.id}`));
  const service = accessory.addService(item.type === 'light' ? Service.Lightbulb : Service.Switch, item.name);
  let state = false;
  service.getCharacteristic(Characteristic.On)
    .onGet(() => state)
    .onSet((value) => {
      state = Boolean(value);
      bus.write(item.writeAddress, state ? 1 : 0, 'DPT1.001');
    });
  bus.subscribe(item.statusAddress || item.writeAddress, (value) => {
    state = normalizeBool(value);
    service.updateCharacteristic(Characteristic.On, state);
  });
  setAccessoryInfo(accessory, item);
  return accessory;
}

function createDimmer(item, bus) {
  const accessory = new Accessory(item.name, uuid.generate(`knx:${item.id}`));
  const service = accessory.addService(Service.Lightbulb, item.name);
  let on = false;
  let brightness = 0;
  service.getCharacteristic(Characteristic.On)
    .onGet(() => on)
    .onSet((value) => {
      on = Boolean(value);
      bus.write(item.switchWriteAddress, on ? 1 : 0, 'DPT1.001');
    });
  service.getCharacteristic(Characteristic.Brightness)
    .onGet(() => brightness)
    .onSet((value) => {
      brightness = Math.max(0, Math.min(100, Number(value)));
      bus.write(item.brightnessWriteAddress, brightness, 'DPT5.001');
    });
  bus.subscribe(item.switchStatusAddress || item.switchWriteAddress, (value) => {
    on = normalizeBool(value);
    service.updateCharacteristic(Characteristic.On, on);
  });
  bus.subscribe(item.brightnessStatusAddress || item.brightnessWriteAddress, (value) => {
    const n = normalizeNumber(value);
    if (Number.isFinite(n)) {
      brightness = Math.max(0, Math.min(100, Math.round(n)));
      service.updateCharacteristic(Characteristic.Brightness, brightness);
    }
  });
  setAccessoryInfo(accessory, item);
  return accessory;
}

function createTemperature(item, bus) {
  const accessory = new Accessory(item.name, uuid.generate(`knx:${item.id}`));
  const service = accessory.addService(Service.TemperatureSensor, item.name);
  let temperature = 20;
  service.getCharacteristic(Characteristic.CurrentTemperature).onGet(() => temperature);
  bus.subscribe(item.statusAddress, (value) => {
    const n = normalizeNumber(value);
    if (Number.isFinite(n)) {
      temperature = Math.max(-100, Math.min(100, n));
      service.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
    }
  });
  setAccessoryInfo(accessory, item);
  return accessory;
}

function createContact(item, bus) {
  const accessory = new Accessory(item.name, uuid.generate(`knx:${item.id}`));
  const service = accessory.addService(Service.ContactSensor, item.name);
  let contact = Characteristic.ContactSensorState.CONTACT_DETECTED;
  service.getCharacteristic(Characteristic.ContactSensorState).onGet(() => contact);
  bus.subscribe(item.statusAddress, (value) => {
    const open = normalizeBool(value);
    contact = open
      ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : Characteristic.ContactSensorState.CONTACT_DETECTED;
    service.updateCharacteristic(Characteristic.ContactSensorState, contact);
  });
  setAccessoryInfo(accessory, item);
  return accessory;
}

function createBlind(item, bus) {
  const accessory = new Accessory(item.name, uuid.generate(`knx:${item.id}`));
  const service = accessory.addService(Service.WindowCovering, item.name);
  let current = 0;
  let target = 0;
  const convert = (n) => item.invert ? 100 - n : n;
  service.getCharacteristic(Characteristic.CurrentPosition).onGet(() => current);
  service.getCharacteristic(Characteristic.TargetPosition)
    .onGet(() => target)
    .onSet((value) => {
      target = Math.max(0, Math.min(100, Number(value)));
      bus.write(item.positionWriteAddress, convert(target), 'DPT5.001');
      service.updateCharacteristic(Characteristic.PositionState, Characteristic.PositionState.DECREASING);
    });
  service.getCharacteristic(Characteristic.PositionState)
    .onGet(() => Characteristic.PositionState.STOPPED);
  bus.subscribe(item.positionStatusAddress || item.positionWriteAddress, (value) => {
    const n = normalizeNumber(value);
    if (Number.isFinite(n)) {
      current = Math.max(0, Math.min(100, Math.round(convert(n))));
      service.updateCharacteristic(Characteristic.CurrentPosition, current);
      if (Math.abs(current - target) <= 2) {
        service.updateCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);
      }
    }
  });
  setAccessoryInfo(accessory, item);
  return accessory;
}

function buildAccessory(item, bus) {
  if (!item.id || !item.name || !item.type) throw new Error('Her aksesuar için id, name ve type zorunludur.');
  switch (item.type) {
    case 'switch':
    case 'light': return createSwitch(item, bus);
    case 'dimmer': return createDimmer(item, bus);
    case 'temperature': return createTemperature(item, bus);
    case 'contact': return createContact(item, bus);
    case 'blind': return createBlind(item, bus);
    default: throw new Error(`Desteklenmeyen aksesuar tipi: ${item.type}`);
  }
}

async function startBridge() {
  const config = loadConfig();
  fs.mkdirSync(STORAGE_PATH, { recursive: true });
  HAPStorage.setCustomStoragePath(STORAGE_PATH);

  const bus = new KnxBus(config.knx);
  await bus.connect();

  const bridge = new Bridge(config.homekit.name || 'KNX Bridge Pro', uuid.generate('knx-bridge-pro'));
  for (const item of config.accessories) {
    if (item.enabled === false) continue;
    bridge.addBridgedAccessory(buildAccessory(item, bus));
    log(`HomeKit aksesuarı hazır: ${item.name} (${item.type})`);
  }

  const username = config.homekit.username || '02:11:22:33:44:55';
  const pincode = config.homekit.pincode || '031-45-154';
  const port = Number(config.homekit.port || 51826);

  bridge.on('listening', () => {
    log(`HomeKit köprüsü çalışıyor. PIN: ${pincode}`);
    try {
      if (hap.AccessorySetupPayload && typeof hap.AccessorySetupPayload.generateSetupPayload === 'function') {
        const payload = hap.AccessorySetupPayload.generateSetupPayload(pincode, username, Categories.BRIDGE);
        qrcode.generate(payload, { small: true });
      }
    } catch (error) {
      log(`QR kod üretilemedi; PIN ile ekleyebilirsiniz: ${error.message}`);
    }
    for (const item of config.accessories) {
      ['statusAddress', 'switchStatusAddress', 'brightnessStatusAddress', 'positionStatusAddress']
        .forEach((key) => item[key] && bus.read(item[key]));
    }
  });

  bridge.publish({
    username,
    pincode,
    port,
    category: Categories.BRIDGE,
  });

  process.on('SIGINT', () => {
    log('Köprü kapatılıyor...');
    try { bridge.unpublish(); } catch (_) {}
    process.exit(0);
  });
}

async function main() {
  console.log(`\nKNX Bridge Pro v${VERSION}\n`);
  if (process.argv[2] === 'discover') {
    log(`Yerel IPv4 adresleri: ${localIPv4().join(', ') || 'bulunamadı'}`);
    const devices = await discoverGateways();
    if (devices.length === 0) {
      log('KNX/IP cihazı bulunamadı. Bilgisayar ve KNX gateway aynı yerel ağda olmalıdır.');
    } else {
      console.log('\nconfig.yml içine yazılabilecek gateway adresleri:');
      devices.forEach((device) => console.log(`  gatewayIp: "${device.address}"  # port ${device.port}`));
    }
    console.log('\nKapatmak için Enter tuşuna basın.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(0));
    return;
  }
  await startBridge();
}

main().catch((error) => fail('Program başlatılamadı.', error));
