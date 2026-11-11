import type { AssetStatus, PlantPlace, PlantSource, PlantStamp, Translations } from './plant.js';
import type { PlantAssignmentAdditions, PlantInterfaceOverride, PlantModelOrigin, PlantProfilePointOverride, PlantResolvedProfile } from './plantModel.js';

/**
 * Plant registry, part 2 (#219): which data the interfaces of an asset deliver and which KPIs are computed from it.
 *
 * - **Device profiles** – a catalogue for the whole installation: a kind of controller or device (manufacturer, model,
 *   version) with its **interfaces** (OPC UA, Modbus/TCP, MQTT, file transfer, web UI …) and their **data points**
 *   in groups: data type, unit, address, access, update rate.
 * - **Assignment** – per asset: the profile it has, its controller firmware, per interface whether it is set up and
 *   where (endpoint), data points that differ on this asset (overrides) and where data points are published.
 * - **KPI definitions** – a catalogue: inputs (a profile's data points), parameters, the columns a computation writes
 *   (sum, ratio, ignore), and the ISO 22400-2 attributes of a KPI (formula, unit, range, trend, timing, audience).
 * - **KPI instances** – per asset: a computation job of a definition with its parameters and where its result is shown.
 *
 * Standards: OPC UA (IEC 62541) NodeId notation and built-in data types, the Modbus Application Protocol (function
 * codes, the four tables), IEC 61131-3 elementary data types, UCUM codes for units, ISO 22400-2 for KPI attributes.
 * See docs/PLANT.md ("Data points and KPIs").
 */

/** Ids of data points, interfaces, parameters and columns: devices name them, so capitals are allowed (`voltage_L1`). */
export const PLANT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/;

// ---------- interfaces ----------

/** Protocols of an interface. File transfer: smb, webdav, sftp, ftp. */
export const PLANT_PROTOCOLS = ['opc_ua', 'modbus_tcp', 'mqtt', 'http', 'smb', 'webdav', 'sftp', 'ftp', 'other'] as const;
export type PlantProtocol = (typeof PLANT_PROTOCOLS)[number];
export const PLANT_FILE_PROTOCOLS: readonly PlantProtocol[] = ['smb', 'webdav', 'sftp', 'ftp'];

/** The usual port of a protocol (a suggestion in the form). */
export const PROTOCOL_PORTS: Partial<Record<PlantProtocol, number>> = {
  opc_ua: 4840,
  modbus_tcp: 502,
  mqtt: 8883,
  http: 443,
  smb: 445,
  webdav: 443,
  sftp: 22,
  ftp: 21,
};

/** Direction of an interface or data point, seen from whoever reads the device. */
export const PLANT_DIRECTIONS = ['read', 'write', 'read_write'] as const;
export type PlantDirection = (typeof PLANT_DIRECTIONS)[number];

/** How a client signs in at an interface. */
export const PLANT_AUTH_KINDS = ['none', 'username_password', 'certificate', 'token', 'other'] as const;
export type PlantAuthKind = (typeof PLANT_AUTH_KINDS)[number];

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s/._-]+/g, '_');

const PROTOCOL_SPELLINGS: Record<string, PlantProtocol> = {
  opc_ua: 'opc_ua',
  opcua: 'opc_ua',
  opc: 'opc_ua',
  modbus_tcp: 'modbus_tcp',
  modbustcp: 'modbus_tcp',
  modbus: 'modbus_tcp',
  mqtt: 'mqtt',
  http: 'http',
  https: 'http',
  web: 'http',
  web_ui: 'http',
  smb: 'smb',
  cifs: 'smb',
  smb_cifs: 'smb',
  webdav: 'webdav',
  sftp: 'sftp',
  ftp: 'ftp',
  ftps: 'ftp',
  other: 'other',
};
/** A protocol as written in a file (`OPC-UA`, `Modbus/TCP`, `SMB/CIFS` …) as its value, or null. */
export const protocolOf = (s: string): PlantProtocol | null => PROTOCOL_SPELLINGS[norm(s)] ?? null;

const AUTH_SPELLINGS: Record<string, PlantAuthKind> = {
  none: 'none',
  anonymous: 'none',
  username_password: 'username_password',
  user_password: 'username_password',
  password: 'username_password',
  basic: 'username_password',
  certificate: 'certificate',
  x509: 'certificate',
  token: 'token',
  api_key: 'token',
  other: 'other',
};
export const authKindOf = (s: string): PlantAuthKind | null => AUTH_SPELLINGS[norm(s)] ?? null;

const DIRECTION_SPELLINGS: Record<string, PlantDirection> = {
  read: 'read',
  r: 'read',
  ro: 'read',
  write: 'write',
  w: 'write',
  wo: 'write',
  read_write: 'read_write',
  readwrite: 'read_write',
  rw: 'read_write',
  both: 'read_write',
};
export const directionOf = (s: string): PlantDirection | null => DIRECTION_SPELLINGS[norm(s)] ?? null;

// ---------- data types ----------

/** OPC UA built-in data types (IEC 62541-6) and the abstract types Number, Integer, UInteger (IEC 62541-3). */
export const OPC_UA_DATA_TYPES = [
  'Boolean',
  'SByte',
  'Byte',
  'Int16',
  'UInt16',
  'Int32',
  'UInt32',
  'Int64',
  'UInt64',
  'Float',
  'Double',
  'String',
  'DateTime',
  'Guid',
  'ByteString',
  'XmlElement',
  'NodeId',
  'LocalizedText',
  'Duration',
  'Number',
  'Integer',
  'UInteger',
  'Enumeration',
  'Structure',
] as const;

/** IEC 61131-3 elementary data types (PLCs). */
export const IEC_61131_DATA_TYPES = [
  'BOOL',
  'BYTE',
  'WORD',
  'DWORD',
  'LWORD',
  'SINT',
  'INT',
  'DINT',
  'LINT',
  'USINT',
  'UINT',
  'UDINT',
  'ULINT',
  'REAL',
  'LREAL',
  'TIME',
  'LTIME',
  'DATE',
  'TIME_OF_DAY',
  'TOD',
  'DATE_AND_TIME',
  'DT',
  'CHAR',
  'WCHAR',
  'STRING',
  'WSTRING',
] as const;

/** Generic spellings and the OPC UA type they stand for. */
const TYPE_SPELLINGS: Record<string, string> = {
  bool: 'Boolean',
  boolean: 'Boolean',
  int: 'Integer',
  integer: 'Integer',
  uint: 'UInteger',
  float: 'Float',
  double: 'Double',
  number: 'Number',
  string: 'String',
  text: 'String',
  str: 'String',
  datetime: 'DateTime',
  timestamp: 'DateTime',
  bytes: 'ByteString',
  enum: 'Enumeration',
};

/**
 * A data type as written (`float`, `int[]`, `REAL`, `UInt16`) as it is stored: an OPC UA type in its spelling, an
 * IEC 61131-3 type in capitals, `[]` for an array. Null: not a known type. Empty stays empty (not given).
 */
export function dataTypeOf(s: string): string | null {
  const raw = s.trim();
  if (!raw) return '';
  const array = raw.endsWith('[]');
  const base = array ? raw.slice(0, -2).trim() : raw;
  let out: string | undefined = (IEC_61131_DATA_TYPES as readonly string[]).includes(base) ? base : undefined;
  out ??= OPC_UA_DATA_TYPES.find((x) => x.toLowerCase() === base.toLowerCase());
  out ??= TYPE_SPELLINGS[base.toLowerCase()];
  out ??= (IEC_61131_DATA_TYPES as readonly string[]).find((x) => x === base.toUpperCase());
  return out ? `${out}${array ? '[]' : ''}` : null;
}

// ---------- units (UCUM) ----------

/** Common UCUM codes (case sensitive) with their display symbol. */
export const PLANT_UNITS: { code: string; symbol: string }[] = [
  { code: '%', symbol: '%' },
  { code: '1', symbol: '1' },
  { code: 'ns', symbol: 'ns' },
  { code: 'us', symbol: 'µs' },
  { code: 'ms', symbol: 'ms' },
  { code: 's', symbol: 's' },
  { code: 'min', symbol: 'min' },
  { code: 'h', symbol: 'h' },
  { code: 'd', symbol: 'd' },
  { code: 'um', symbol: 'µm' },
  { code: 'mm', symbol: 'mm' },
  { code: 'm', symbol: 'm' },
  { code: 'mm/s', symbol: 'mm/s' },
  { code: 'mm/min', symbol: 'mm/min' },
  { code: 'm/s', symbol: 'm/s' },
  { code: 'm/min', symbol: 'm/min' },
  { code: 'deg', symbol: '°' },
  { code: 'rad', symbol: 'rad' },
  { code: '/min', symbol: '1/min' },
  { code: 'Hz', symbol: 'Hz' },
  { code: 'Cel', symbol: '°C' },
  { code: 'K', symbol: 'K' },
  { code: '[degF]', symbol: '°F' },
  { code: 'mA', symbol: 'mA' },
  { code: 'A', symbol: 'A' },
  { code: 'mV', symbol: 'mV' },
  { code: 'V', symbol: 'V' },
  { code: 'kV', symbol: 'kV' },
  { code: 'W', symbol: 'W' },
  { code: 'kW', symbol: 'kW' },
  { code: 'MW', symbol: 'MW' },
  { code: 'V.A', symbol: 'VA' },
  { code: 'kV.A', symbol: 'kVA' },
  { code: 'W.h', symbol: 'Wh' },
  { code: 'kW.h', symbol: 'kWh' },
  { code: 'MW.h', symbol: 'MWh' },
  { code: 'J', symbol: 'J' },
  { code: 'kJ', symbol: 'kJ' },
  { code: 'N', symbol: 'N' },
  { code: 'kN', symbol: 'kN' },
  { code: 'N.m', symbol: 'N·m' },
  { code: 'Pa', symbol: 'Pa' },
  { code: 'kPa', symbol: 'kPa' },
  { code: 'bar', symbol: 'bar' },
  { code: 'mbar', symbol: 'mbar' },
  { code: 'g', symbol: 'g' },
  { code: 'kg', symbol: 'kg' },
  { code: 't', symbol: 't' },
  { code: 'L', symbol: 'l' },
  { code: 'L/min', symbol: 'l/min' },
  { code: 'm3', symbol: 'm³' },
  { code: 'm3/h', symbol: 'm³/h' },
  { code: '{count}', symbol: 'count' },
];

/** Usual non-UCUM spellings and the UCUM code they mean. */
const UNIT_SPELLINGS: Record<string, string> = {
  kWh: 'kW.h',
  Wh: 'W.h',
  MWh: 'MW.h',
  kVA: 'kV.A',
  VA: 'V.A',
  '°C': 'Cel',
  degC: 'Cel',
  '°F': '[degF]',
  '°': 'deg',
  rpm: '/min',
  '1/min': '/min',
  'm³': 'm3',
  'm³/h': 'm3/h',
  µs: 'us',
  µm: 'um',
  l: 'L',
  'l/min': 'L/min',
  Nm: 'N.m',
  sec: 's',
};

/** A unit as stored: the UCUM code for usual spellings (`kWh` → `kW.h`), else as written. */
export const unitCode = (s: string): string => {
  const v = s.trim();
  return UNIT_SPELLINGS[v] ?? v;
};

/** The symbol a unit is shown with (`kW.h` → kWh); a code the table does not know is shown as it is. */
export const unitSymbol = (code: string): string => PLANT_UNITS.find((u) => u.code === code)?.symbol ?? code;

/**
 * 0.12.0: units of one quantity and their factor to a reference unit (UCUM codes). Two units of a group convert by a
 * pure factor (W.h ↔ kW.h ↔ J); temperatures (Cel, K, [degF]) differ by an offset and do not.
 */
const UNIT_FACTORS: Record<string, [string, number]> = {
  ns: ['s', 1e-9],
  us: ['s', 1e-6],
  ms: ['s', 1e-3],
  s: ['s', 1],
  min: ['s', 60],
  h: ['s', 3600],
  d: ['s', 86400],
  um: ['m', 1e-6],
  mm: ['m', 1e-3],
  cm: ['m', 1e-2],
  m: ['m', 1],
  km: ['m', 1e3],
  'mm/s': ['m/s', 1e-3],
  'mm/min': ['m/s', 1e-3 / 60],
  'm/s': ['m/s', 1],
  'm/min': ['m/s', 1 / 60],
  deg: ['rad', Math.PI / 180],
  rad: ['rad', 1],
  '/min': ['/s', 1 / 60],
  '/s': ['/s', 1],
  Hz: ['/s', 1],
  kHz: ['/s', 1e3],
  mA: ['A', 1e-3],
  A: ['A', 1],
  kA: ['A', 1e3],
  mV: ['V', 1e-3],
  V: ['V', 1],
  kV: ['V', 1e3],
  mW: ['W', 1e-3],
  W: ['W', 1],
  kW: ['W', 1e3],
  MW: ['W', 1e6],
  'V.A': ['V.A', 1],
  'kV.A': ['V.A', 1e3],
  'MV.A': ['V.A', 1e6],
  var: ['var', 1],
  kvar: ['var', 1e3],
  'W.h': ['J', 3600],
  'kW.h': ['J', 3.6e6],
  'MW.h': ['J', 3.6e9],
  J: ['J', 1],
  kJ: ['J', 1e3],
  MJ: ['J', 1e6],
  N: ['N', 1],
  kN: ['N', 1e3],
  'N.m': ['N.m', 1],
  Pa: ['Pa', 1],
  kPa: ['Pa', 1e3],
  MPa: ['Pa', 1e6],
  bar: ['Pa', 1e5],
  mbar: ['Pa', 100],
  mg: ['g', 1e-3],
  g: ['g', 1],
  kg: ['g', 1e3],
  t: ['g', 1e6],
  mL: ['L', 1e-3],
  L: ['L', 1],
  m3: ['L', 1e3],
  'L/min': ['L/s', 1 / 60],
  'L/s': ['L/s', 1],
  'm3/h': ['L/s', 1000 / 3600],
  '%': ['1', 0.01],
  '1': ['1', 1],
};

/** How two units (as written or UCUM codes) relate: the same unit, convertible by a pure factor, or not. */
export type PlantUnitRelation = 'same' | 'convertible' | 'incompatible';

/**
 * 0.12.0: whether two units are the same (after reading usual spellings as their UCUM code: kWh = kW.h), differ by a
 * pure factor (W.h and kW.h, bar and kPa, % and 1) or cannot be converted that way (kW and kW.h, Cel and K).
 */
export function unitRelation(a: string, b: string): PlantUnitRelation {
  const x = unitCode(a);
  const y = unitCode(b);
  if (x === y) return 'same';
  const fx = UNIT_FACTORS[x];
  const fy = UNIT_FACTORS[y];
  return fx && fy && fx[0] === fy[0] ? 'convertible' : 'incompatible';
}

// ---------- addresses ----------

/**
 * OPC UA NodeId in its string notation (IEC 62541-6 5.3.1.10): `ns=<index>;` or `nsu=<uri>;` (optional), then
 * `i=<number>`, `s=<string>`, `g=<guid>` or `b=<base64>`.
 */
export function opcUaNodeIdProblem(v: string): string | null {
  const m = /^(?:(?:ns=(\d{1,5})|nsu=([^;]+));)?([isgb])=(.+)$/s.exec(v);
  if (!m) return 'Use the OPC UA NodeId notation: ns=<index>;i=<number> or ns=<index>;s=<name> (also g= and b=)';
  const [, ns, , kind, id] = m;
  if (ns !== undefined && Number(ns) > 65535) return 'The namespace index is at most 65535';
  if (kind === 'i' && !/^\d{1,10}$/.test(id!)) return 'A numeric identifier (i=) is a number';
  if (kind === 'g' && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id!)) return 'A GUID identifier (g=) is a GUID';
  return null;
}

/** The four Modbus tables (Modbus Application Protocol 1.1b3) and the function codes that read and write them. */
export const MODBUS_TABLES = {
  coil: { read: 1, write: [5, 15] },
  discrete: { read: 2, write: [] },
  input: { read: 4, write: [] },
  holding: { read: 3, write: [6, 16] },
} as const;
export type ModbusTable = keyof typeof MODBUS_TABLES;
const MODBUS_SPELLINGS: Record<string, ModbusTable> = {
  coil: 'coil',
  c: 'coil',
  co: 'coil',
  discrete: 'discrete',
  di: 'discrete',
  d: 'discrete',
  input: 'input',
  ir: 'input',
  i: 'input',
  holding: 'holding',
  hr: 'holding',
  h: 'holding',
};

/**
 * A Modbus address: `<table>:<address>[,<count>]` – table coil, discrete, input or holding (or c, di, ir, hr, also
 * the one-letter forms), the 0-based PDU address (0–65535) and the number of registers or bits (1–125, default 1).
 */
export function modbusAddress(v: string): { table: ModbusTable; address: number; count: number; readCode: number } | null {
  const m = /^([a-z]+):(\d{1,5})(?:,(\d{1,3}))?$/i.exec(v.trim());
  const table = m ? MODBUS_SPELLINGS[m[1]!.toLowerCase()] : undefined;
  if (!m || !table) return null;
  const address = Number(m[2]);
  const count = m[3] === undefined ? 1 : Number(m[3]);
  if (address > 65535 || count < 1 || count > 125) return null;
  return { table, address, count, readCode: MODBUS_TABLES[table].read };
}

/** What is wrong with a data point's address on an interface of this protocol (null: fine or not checked). */
export function addressProblem(protocol: PlantProtocol, address: string): string | null {
  if (!address) return null;
  if (protocol === 'opc_ua') return opcUaNodeIdProblem(address);
  if (protocol === 'modbus_tcp' && !modbusAddress(address))
    return 'Use a Modbus address: <table>:<address>[,<count>] with table coil, discrete, input or holding (0-based, e.g. holding:100 or input:7,2)';
  return null;
}

// ---------- device profiles ----------

export interface PlantPublicationTarget {
  /** The system it is published to (an IoT platform, a historian …), free text */
  target: string;
  /** Where there: a path, an aspect, a topic */
  path: string;
  /** Its name there: a variable, a tag */
  name: string;
}

/**
 * 0.17.0: where a data point is described – the document (a manual, a data sheet) and the place in it. An assistant that
 * reads a manual names it in its proposal; the review and the profile show it (docs/PLANT.md "Sources of data points").
 */
export interface PlantPointSource {
  /** The document: its title (with its version), or the number of a record in Steward that keeps it (DOC-12) */
  document: string;
  /** The page or pages, as the document numbers them (empty: not given) */
  page: string;
  /** The section: its number and title (empty: not given) */
  section: string;
}

/** 0.17.0: the length of a source's texts. */
export const PLANT_POINT_SOURCE_LIMITS = { document: 200, page: 40, section: 200 } as const;

export interface PlantDataPoint {
  /** Stable id, unique in the profile (KPI inputs, overrides and publications name it) */
  id: string;
  name: string;
  description: string;
  /** OPC UA built-in type, IEC 61131-3 type or empty; `[]` for an array */
  dataType: string;
  /** UCUM code (`kW.h`, `Cel`, `/min`) or empty */
  unit: string;
  /** OPC UA NodeId, Modbus `<table>:<address>[,<count>]`, a topic, a file path or column … */
  address: string;
  access: PlantDirection;
  /** Typical update rate in milliseconds */
  updateRateMs: number | null;
  /** The values of a text or code data point */
  enumValues: string[];
  /** Known as (0.11.0): names that tools commonly use for it – a gateway's variable names, for example */
  aliases: string[];
  notes: string;
  /** Where it is usually published (the assignment of an asset says where it really is) */
  publications: PlantPublicationTarget[];
  /** 0.17.0: where it is described (a manual and the page); left out or null: not known */
  source?: PlantPointSource | null;
}

export interface PlantPointGroup {
  /** Empty: the data points of the interface without a group */
  name: string;
  description: string;
  dataPoints: PlantDataPoint[];
}

/** Files a file-transfer interface exchanges. */
export interface PlantFileSet {
  id: string;
  name: string;
  description: string;
  /** csv, xml, a program format … */
  format: string;
  direction: PlantDirection;
  /** Path or file name pattern (`/archive/*.csv`) */
  pathPattern: string;
  /** One file per … (part, shift, day) */
  producedPer: string;
  retention: string;
  encoding: string;
  notes: string;
}

export interface PlantInterface {
  /** Stable id, unique in the profile */
  id: string;
  name: string;
  protocol: PlantProtocol;
  direction: PlantDirection;
  description: string;
  /** Protocol or interface version */
  version: string;
  defaultPort: number | null;
  authentication: PlantAuthKind;
  /** The client it needs (a gateway, a driver, "manual") */
  client: string;
  notes: string;
  groups: PlantPointGroup[];
  fileSets: PlantFileSet[];
}

export interface PlantProfileValues {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  /** Firmware or product version the profile describes (`2.x`, `any`) */
  version: string;
  /** Controller, power meter, robot controller … */
  category: string;
  description: string;
  notes: string;
  /** Own interfaces (for a derived profile: the ones it adds) */
  interfaces: PlantInterface[];
  /** The base profile this one extends (0.11.0), or null */
  extends: string | null;
  /**
   * 0.12.0: a template – only for other profiles to extend; no asset may have it (not inherited: a profile that extends
   * a template is none)
   */
  template: boolean;
  /** Changes to inherited interfaces, and data points added to them (empty without a base) */
  interfaceOverrides: PlantInterfaceOverride[];
  /** Changes to inherited data points (empty without a base) */
  pointOverrides: PlantProfilePointOverride[];
}

/** An asset as the pages of part 2 name it. */
export interface PlantAssetBrief {
  id: string;
  name: string;
  status: AssetStatus;
  siteId: string;
  site: PlantPlace & { code: string };
}

export interface PlantProfileSummary extends PlantSource {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  version: string;
  category: string;
  protocols: PlantProtocol[];
  interfaceCount: number;
  dataPointCount: number;
  /** Assets with this profile that the reader may see */
  assetCount: number;
  /** The base profile (0.11.0), or null */
  extends: string | null;
  /** 0.12.0: a template – only for other profiles to extend */
  template: boolean;
  updatedAt: string;
}

export interface PlantProfileDetail extends PlantProfileSummary, PlantStamp {
  /** The description in effect: the profile's own, or (0.12.0) the nearest base's when it has none */
  description: string;
  /** 0.12.0: the profile whose description is in effect (this one, or a base) */
  descriptionFrom: string;
  notes: string;
  /** The effective interfaces: inherited, changed and own (see `origins`) */
  interfaces: PlantInterface[];
  /** The profile's own part, as stored and edited (0.11.0) */
  own: PlantProfileValues;
  /** The bases, nearest first (empty: no base) */
  bases: { id: string; name: string; exists: boolean }[];
  /** The effective model of the base (what this profile inherits), for editing overrides; null without a base */
  base: Pick<PlantResolvedProfile, 'id' | 'name' | 'interfaces'> | null;
  origins: PlantResolvedProfile['origins'];
  notPresent: PlantResolvedProfile['notPresent'];
  unusedOverrides: PlantResolvedProfile['unusedOverrides'];
  /** Profiles that extend this one directly */
  extendedBy: { id: string; name: string }[];
  /** Assets with this profile (that the reader may see) */
  assets: PlantAssetBrief[];
  /** KPI definitions that read data points of this profile */
  kpis: { id: string; name: string; names: Translations; dataPoints: string[] }[];
  canManage: boolean;
  /** 0.13.0: may keep drafts of changes to it (propose on some site) */
  canPropose?: boolean;
}

/** GET /api/plant/profiles/:id/points/:pointId: a data point and who delivers it. */
export interface PlantDataPointDetail {
  profile: { id: string; name: string; manufacturer: string; model: string };
  interface: { id: string; name: string; protocol: PlantProtocol; direction: PlantDirection };
  group: string;
  point: PlantDataPoint;
  /** Where the data point comes from (0.11.0: inherited from a base, changed here, or the profile's own) */
  origin: PlantModelOrigin;
  /** Assets with the profile or one that extends it (that the reader may see), and whether each delivers the data point */
  assets: {
    asset: PlantAssetBrief;
    delivers: boolean;
    /** Why not: the interface is not set up or not active, or an override says the asset lacks it */
    reason: 'interface_inactive' | 'unavailable' | null;
    endpoint: string;
    override: PlantPointOverride | null;
    publications: PlantPublication[];
  }[];
  kpis: { id: string; name: string; names: Translations }[];
}

// ---------- assignments ----------

export interface PlantAssignmentInterface {
  /** The profile's interface */
  interface: string;
  /** Set up and delivering on this asset */
  active: boolean;
  /** Where: opc.tcp://…, a host and port, a share or URL */
  endpoint: string;
  notes: string;
}

/** A data point that differs on this asset (null: as in the profile). */
export interface PlantPointOverride {
  dataPoint: string;
  /** False: this asset does not deliver it */
  available: boolean;
  address: string | null;
  unit: string | null;
  dataType: string | null;
  updateRateMs: number | null;
  notes: string;
}

export interface PlantPublication extends PlantPublicationTarget {
  dataPoint: string;
  /** Who publishes it (a gateway, a connector) */
  publishedBy: string;
  notes: string;
}

export type KpiParamValue = string | number | boolean | null;

export interface PlantKpiInstance {
  /** The KPI definition */
  kpi: string;
  /** The computation job's name, unique per asset */
  job: string;
  active: boolean;
  params: Record<string, KpiParamValue>;
  /** Where the result is shown: a Steward dashboard (id) and/or dataset (key) */
  dashboard: string | null;
  dataset: string | null;
  notes: string;
}

export interface PlantAssignmentValues {
  /** The device profile (null: none – KPI instances only) */
  profileId: string | null;
  firmware: string;
  interfaces: PlantAssignmentInterface[];
  overrides: PlantPointOverride[];
  /** Data points and interfaces of this asset alone (0.11.0) */
  additions: PlantAssignmentAdditions;
  publications: PlantPublication[];
  kpis: PlantKpiInstance[];
  notes: string;
}

/** A Steward item a KPI instance names, as the reader may see it. */
export interface PlantResultLink {
  kind: 'dashboard' | 'dataset';
  id: string;
  /** Empty when not visible */
  label: string;
  /** Null: not visible, or no page for the reader */
  path: string | null;
  visible: boolean;
}

/** GET /api/plant/assets/:assetId/assignment */
export interface PlantAssignmentView extends PlantSource {
  asset: PlantAssetBrief;
  /** Null: the asset has no assignment yet */
  assignment: PlantAssignmentValues | null;
  /** The assigned profile, resolved (null: none, or it does not exist any more) */
  profile: PlantProfileValues | null;
  /** The asset's model: the profile's interfaces with the asset's additions (0.11.0) */
  model: PlantInterface[];
  /** Interfaces and data points of the model that the asset adds itself */
  added: { interfaces: string[]; points: string[] };
  kpis: (PlantKpiInstance & { definition: { id: string; name: string; names: Translations; category: string } | null; results: PlantResultLink[] })[];
  checks: PlantCheck[];
  /** KPI definitions this asset can have: every data point input is delivered */
  possibleKpis: {
    id: string;
    name: string;
    names: Translations;
    category: string;
    instantiated: boolean;
    /** 0.12.0: data point inputs the asset delivers in another unit than the KPI expects */
    units?: PlantUnitMismatch[];
    /** 0.12.0: a data collection of the asset maps every data point input (the data is collected) */
    collected?: boolean;
    /** 0.13, a KPI that rolls up from parts: the part of this asset that delivers the inputs (the asset itself does not) */
    via?: PlantAssetRef;
  }[];
  canManage: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

// ---------- KPI definitions ----------

/** How a column of a KPI's result is combined over a longer period (summed; numerator over denominator; not at all). */
export const KPI_COLUMN_KINDS = ['sum', 'ratio', 'ignore'] as const;
export type KpiColumnKind = (typeof KPI_COLUMN_KINDS)[number];
export const KPI_PARAM_TYPES = ['number', 'integer', 'string', 'boolean'] as const;
export type KpiParamType = (typeof KPI_PARAM_TYPES)[number];
/** ISO 22400-2 KPI attributes. */
export const KPI_TRENDS = ['higher_is_better', 'lower_is_better', 'none'] as const;
export type KpiTrend = (typeof KPI_TRENDS)[number];
export const KPI_TIMINGS = ['real_time', 'periodic', 'on_demand'] as const;
export type KpiTiming = (typeof KPI_TIMINGS)[number];
export const KPI_AUDIENCES = ['operator', 'supervisor', 'management'] as const;
export type KpiAudience = (typeof KPI_AUDIENCES)[number];
export const KPI_METHODOLOGIES = ['discrete', 'batch', 'continuous'] as const;
export type KpiMethodology = (typeof KPI_METHODOLOGIES)[number];
export const KPI_INPUT_KINDS = ['data_point', 'other'] as const;
export type KpiInputKind = (typeof KPI_INPUT_KINDS)[number];

export interface KpiInput {
  kind: KpiInputKind;
  /** Data points: the profile and its data points the computation reads (with `profiles`: the first of them) */
  profile: string;
  /**
   * 0.13: any of these profiles (two or more; one is `profile` alone): an asset whose profile is, or extends, one of them
   * delivers the input – the first that matches counts. Left out for one profile or none.
   */
  profiles?: string[];
  dataPoints: string[];
  /**
   * 0.12.0: the unit the computation expects, per data point (UCUM code). A data point not listed expects the unit it
   * has in the input's (first) profile (none without a profile: not checked). See the check kpi_unit_mismatch.
   */
  units?: Record<string, string>;
  /**
   * 0.13: per profile (id), the input's data point → that profile's data point, for models that do not share a base.
   * A data point left out has the same id in the profile.
   */
  mapping?: Record<string, Record<string, string>>;
  notes: string;
}

/** 0.13: the profiles a data point input names – any of them (empty: whatever profile the asset has). */
export const kpiInputProfiles = (i: Pick<KpiInput, 'profile' | 'profiles'>): string[] => (i.profiles?.length ? i.profiles : i.profile ? [i.profile] : []);

/** 0.13: the id an input's data point has in one of its profiles: its mapping, else the same id. */
export const kpiInputPoint = (i: Pick<KpiInput, 'mapping'>, profile: string, point: string): string => i.mapping?.[profile]?.[point] ?? point;

/**
 * 0.13: whether a KPI's potential and coverage count for the asset its parts belong to (a machine whose power meter
 * delivers the inputs) – opt-in per definition.
 */
export const KPI_ROLL_UPS = ['none', 'parts'] as const;
export type KpiRollUp = (typeof KPI_ROLL_UPS)[number];

export interface KpiParameter {
  name: string;
  /** Other spellings a job may use */
  aliases: string[];
  type: KpiParamType;
  default: KpiParamValue;
  required: boolean;
  min: number | null;
  max: number | null;
  unit: string;
  description: string;
}

export interface KpiColumn {
  name: string;
  kind: KpiColumnKind;
  /** Which windows the column is written for (e.g. bare, full, per shift): the installation's words */
  scope: string;
  unit: string;
  /** Ratios: the columns divided */
  numerator: string;
  denominator: string;
  /** Ratios: the factor (100 for a percentage) */
  scale: number | null;
  description: string;
}

export interface KpiComputation {
  summary: string;
  /** A diagram (Mermaid or plain text), shown as text */
  diagram: string;
  steps: { name: string; does: string; why: string }[];
  identities: { relation: string; note: string }[];
  /** What the computation cannot tell */
  limits: string[];
}

export interface PlantKpiValues {
  id: string;
  name: string;
  names: Translations;
  /** Availability, performance, quality, energy … */
  category: string;
  /** The installation's kind of KPI (optional) */
  type: string;
  description: string;
  /** ISO 22400-2: formula, unit of measure, range, trend, timing, audience, production methodology */
  formula: string;
  unit: string;
  rangeMin: number | null;
  rangeMax: number | null;
  trend: KpiTrend | null;
  timing: KpiTiming | null;
  audience: KpiAudience[];
  methodology: KpiMethodology | null;
  /** The computing system's name of the method and where its code lives */
  strategy: string;
  implementation: string;
  /** The columns vary from run to run (the list names the fixed ones) */
  dynamicColumns: boolean;
  /** 0.13: KPI potential and coverage of an asset count its parts' (none: off, the default) */
  rollUp: KpiRollUp;
  inputs: KpiInput[];
  parameters: KpiParameter[];
  columns: KpiColumn[];
  computation: KpiComputation;
  notes: string;
}

export interface PlantKpiSummary extends PlantSource {
  id: string;
  name: string;
  names: Translations;
  category: string;
  unit: string;
  trend: KpiTrend | null;
  /** The profiles its data point inputs come from */
  profiles: string[];
  parameterCount: number;
  columnCount: number;
  /** KPI instances on assets the reader may see */
  instanceCount: number;
  /** Problems of the definition itself (a ratio without its denominator …) */
  problemCount: number;
  updatedAt: string;
}

export interface PlantKpiDetail extends PlantKpiSummary, PlantStamp, PlantKpiValues {
  /** The profiles of the inputs as names (null: the profile does not exist) */
  profileNames: Record<string, string | null>;
  checks: PlantCheck[];
  /** Assets (that the reader may see) with an instance */
  instances: { asset: PlantAssetBrief; job: string; active: boolean; problems: number }[];
  /** Assets (that the reader may see) that deliver every input but have no instance */
  candidates: PlantAssetBrief[];
  /**
   * 0.12.0: per candidate (asset id) whether its data is collected already (a data collection maps every data point
   * input) and the inputs it delivers in another unit
   */
  candidateInfo?: Record<string, { collected: boolean; units: PlantUnitMismatch[]; via?: PlantAssetRef }>;
  canManage: boolean;
  /** 0.13.0: may keep drafts of changes to it (propose on some site) */
  canPropose?: boolean;
}

// ---------- checks ----------

/**
 * 0.12.0: a data point input an asset delivers in another unit than the KPI expects (the KPI input's unit, else the
 * unit of the data point in the input's profile). Convertible: by a pure factor (W.h and kW.h); else not at all.
 */
/** 0.13: an asset by id and name (a part a KPI's potential comes from, the machine a part counts for). */
export interface PlantAssetRef {
  id: string;
  name: string;
}

export interface PlantUnitMismatch {
  /** The data point of the asset (with a mapping: the profile's id) */
  point: string;
  /** 0.13: the input's data point, where a mapping gives the asset's another id */
  input?: string;
  expected: string;
  actual: string;
  relation: 'convertible' | 'incompatible';
}

/** What Steward checks in part 2: an asset's assignment and KPI instances, and the KPI definitions. */
export const PLANT_CHECK_CODES = [
  'profile_unknown',
  'interface_unknown',
  'point_unknown',
  'kpi_unknown',
  'kpi_no_profile',
  'kpi_other_profile',
  'kpi_point_unknown',
  'kpi_point_unavailable',
  'kpi_interface_inactive',
  'kpi_unit_mismatch',
  'param_unknown',
  'param_type',
  'param_range',
  'param_required',
  'param_twice',
  'ratio_no_denominator',
  'ratio_no_numerator',
  'ratio_column_unknown',
  'input_profile_unknown',
  'input_point_unknown',
  'addition_shadowed',
] as const;
export type PlantCheckCode = (typeof PLANT_CHECK_CODES)[number];

export interface PlantCheck {
  code: PlantCheckCode;
  /** The record the problem is on */
  subject: { kind: 'asset'; id: string; name: string; siteId: string } | { kind: 'kpi'; id: string; name: string };
  /** The KPI instance (asset checks) */
  job?: string;
  /** Plain English text; the web app shows it from code and params */
  message: string;
  params: Record<string, string | number>;
}

/** GET /api/plant/explore/points?q=: data points across the profiles. */
export interface PlantPointHit {
  profile: { id: string; name: string };
  interface: { id: string; name: string; protocol: PlantProtocol };
  group: string;
  point: Pick<PlantDataPoint, 'id' | 'name' | 'dataType' | 'unit' | 'address'>;
  /** Assets (that the reader may see) that deliver it */
  deliveredBy: number;
}

export const PLANT_DATA_LIMITS = {
  profiles: 2000,
  kpis: 1000,
  interfaces: 30,
  groups: 200,
  dataPoints: 5000,
  fileSets: 50,
  enumValues: 200,
  publicationsPerPoint: 10,
  inputs: 50,
  inputPoints: 500,
  /** 0.13: profiles of one input ("any of these") */
  inputProfiles: 20,
  parameters: 100,
  aliases: 10,
  columns: 1000,
  steps: 50,
  identities: 50,
  limits: 50,
  assignmentInterfaces: 30,
  overrides: 5000,
  publications: 5000,
  kpiInstances: 100,
  params: 100,
  text: 200,
  address: 500,
  longText: 8000,
} as const;
