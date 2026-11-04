'use strict';

/**
 * dsh/lib/session-log.js —— DSH 会话日志的共享读取层
 *
 * 从 usage-audit.js 原样抽出的「读文件 → 按 RFC 8878 逐帧切分 → 解压 → 解 JSON 事件」，
 * 供 usage-audit.js 与 route-check.js 共用。**帧解析逻辑没有任何改动**，只是把告警从
 * 直接写 stderr 改成收集到 warnings 数组，由调用方决定怎么输出。
 *
 * 数据源：<dir>/<工作区 slug>/<会话目录>/session.v4.jsonl.zstd
 *   坑：一个日志文件是**多个 zstd 帧拼接**的（实测 500KB 的文件里有 200+ 帧）。
 *   zlib.zstdDecompressSync(整个文件) 只解第一帧、而且**不报错**，
 *   直接解整块只能读到一行 session 头，会误以为日志是空的。
 *   所以这里必须逐帧切分、逐帧解压后拼接。
 *
 *   切帧**不能**靠扫 zstd magic，也**不能**拿 decode(start, EOF) 当某一帧的真值：
 *   zstdDecompressSync 在「首帧明文长度恰为 131072（zstd 单块上限）的整数倍」时会越过
 *   帧边界继续解出后续帧（Node 24.11 实测：首帧明文 131071 字节不泄漏，131072 字节泄漏出
 *   第二帧）。于是 truth 含后面所有帧 → 每个候选边界都比不上 → 整批事件被重复统计
 *   （TOTAL 虚高、退出码仍是 0、只有一条弱告警）。这里改成**按 RFC 8878 精确解析帧结构**：
 *   从 magic 开始读帧头各长度字段，再按 3 字节块头逐块跳过负载，得到该帧的**精确字节范围**，
 *   只对 buf.subarray(start, end) 做单帧解压——不依赖任何未文档化行为。
 *
 *   截断判定因此也是精确的：解析器只在「一整帧刚好在 buf 末尾结束」时认为该帧完整；帧头
 *   字段越界、块循环没走完（缺下一个块头）、块负载越界都只可能是物理截断。截断时用
 *   decode(subarray(start, EOF)) 尽力解出已完成块的前缀（宁可少算），并且必须告警。
 *   skippable frame（magic 0x184D2A50..0x184D2A5F）按自带长度整体跳过，不参与统计。
 *
 * 事件（每行一个 {type, seq, time, data}）：
 *   session            → id
 *   request/header     → data.header.config.{provider, model, reasoningEffort}
 *   assistant/message  → data.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
 *   tool/call          → data.name（工具名）、data.callId
 *   tool/result        → data.message.source.callId（或 data.message.toolCallId / data.toolCallId）
 *   注意 step/end、turn/end 里没有用量，别去那儿找。
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

/** zstd 帧 magic（小端 0xFD2FB528，字节序列 28 B5 2F FD） */
const ZSTD_MAGIC = 0xfd2fb528;
/** skippable frame 的 magic 区间（小端 0x184D2A50..0x184D2A5F，RFC 8878 §3.1.2） */
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
/** Dictionary_ID_Flag → 字段字节数（RFC 8878 §3.1.1.1.3） */
const DICT_ID_SIZE = [0, 1, 2, 4];
/** FCS_Field_Size 组合 → 字段字节数；Single_Segment=1 时 flag 0 表示 1 字节，=0 时表示没有 */
const FCS_SIZE_SINGLE = [1, 2, 4, 8];
const FCS_SIZE_NORMAL = [0, 2, 4, 8];
/**
 * zstd 单块明文的**上限**（128KiB = 131072，ZSTD_BLOCKSIZE_MAX）。只给运行时回归自检用：
 * 首帧明文恰好等于这个长度时，zstdDecompressSync(整块) 会偷解下一帧
 * （见 usage-audit.js 的 checkZstdRuntime）。
 */
const ZSTD_BLOCK = 131072;
/** parseFrame 的返回种类 */
const FRAME_OK = 'zstd';
const FRAME_SKIPPABLE = 'skippable';
const FRAME_TRUNCATED = 'truncated';
const FRAME_CORRUPT = 'corrupt';

/** 告警里带上调用方给的标签（文件名/相对路径），没给就只留消息本身 */
function tag(label, message) {
  return label ? `${label}: ${message}` : message;
}

/**
 * 从 buf[start] 起精确解析**一个** zstd 帧（或 skippable frame）的字节范围。
 * 只读帧头里的长度字段、按块头逐块跳过负载，不做任何「扫 magic」的猜测，也不解压。
 *
 * 返回值：
 *   { kind: FRAME_OK, end }                正常 zstd 帧，字节范围 [start, end)
 *   { kind: FRAME_SKIPPABLE, end }         skippable frame，字节范围 [start, end)
 *   { kind: FRAME_TRUNCATED, detail }      buf 在这一帧走完之前就结束了（物理截断）
 *   { kind: FRAME_CORRUPT, detail }        帧头/块头非法（块类型 3、保留位、非 magic）
 */
function parseFrame(buf, start) {
  const len = buf.length;

  // 1. Magic（4 字节小端）
  if (start + 4 > len) return { kind: FRAME_TRUNCATED, detail: 'frame magic cut off' };
  const magic = buf.readUInt32LE(start);
  if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
    // skippable frame：magic 后 4 字节小端 = 负载字节数，整体跳过（不算帧、不算坏帧）
    if (start + 8 > len) return { kind: FRAME_TRUNCATED, detail: 'skippable frame header cut off' };
    const payload = buf.readUInt32LE(start + 4);
    const end = start + 8 + payload;
    if (end > len) return { kind: FRAME_TRUNCATED, detail: 'skippable frame payload cut off' };
    return { kind: FRAME_SKIPPABLE, end };
  }
  if (magic !== ZSTD_MAGIC) {
    return { kind: FRAME_CORRUPT, detail: `bad magic 0x${magic.toString(16).padStart(8, '0')}` };
  }

  // 2. Frame_Header_Descriptor
  let p = start + 4;
  if (p + 1 > len) return { kind: FRAME_TRUNCATED, detail: 'frame header descriptor cut off' };
  const descriptor = buf[p];
  p += 1;
  const fcsFlag = descriptor >>> 6;
  const singleSegment = (descriptor >>> 5) & 1;
  const unusedBit = (descriptor >>> 4) & 1;
  const reservedBit = (descriptor >>> 3) & 1;
  const hasChecksum = (descriptor >>> 2) & 1;
  const dictFlag = descriptor & 3;
  if (unusedBit !== 0) return { kind: FRAME_CORRUPT, detail: 'frame header unused bit set' };
  if (reservedBit !== 0) return { kind: FRAME_CORRUPT, detail: 'frame header reserved bit set' };

  // 3. Window_Descriptor：仅当 Single_Segment === 0 时存在
  if (singleSegment === 0) {
    if (p + 1 > len) return { kind: FRAME_TRUNCATED, detail: 'window descriptor cut off' };
    p += 1;
  }

  // 4. Dictionary_ID
  const dictSize = DICT_ID_SIZE[dictFlag];
  if (p + dictSize > len) return { kind: FRAME_TRUNCATED, detail: 'dictionary id cut off' };
  p += dictSize;

  // 5. Frame_Content_Size
  const fcsSize = singleSegment === 1 ? FCS_SIZE_SINGLE[fcsFlag] : FCS_SIZE_NORMAL[fcsFlag];
  if (p + fcsSize > len) return { kind: FRAME_TRUNCATED, detail: 'frame content size cut off' };
  p += fcsSize;

  // 6. Blocks：3 字节小端头 = last_block(bit0) | block_type(bit1-2) | block_size(bit3-23)
  for (;;) {
    if (p + 3 > len) return { kind: FRAME_TRUNCATED, detail: 'block header cut off' };
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const lastBlock = header & 1;
    const blockType = (header >>> 1) & 3;
    const blockSize = header >>> 3;
    if (blockType === 3) return { kind: FRAME_CORRUPT, detail: 'reserved block type 3' };
    // Raw / Compressed 负载 = block_size 字节；RLE 负载固定 1 字节
    p += blockType === 1 ? 1 : blockSize;
    if (p > len) return { kind: FRAME_TRUNCATED, detail: 'block payload cut off' };
    if (lastBlock === 1) break;
  }

  // 7. Content_Checksum
  if (hasChecksum === 1) {
    if (p + 4 > len) return { kind: FRAME_TRUNCATED, detail: 'content checksum cut off' };
    p += 4;
  }

  return { kind: FRAME_OK, end: p };
}

/** 尽力解出「被截断的尾帧」里已完成块的内容：解不开就当作没有可读内容（宁可少算也不崩） */
function decodeTruncatedTail(slice) {
  try {
    return zlib.zstdDecompressSync(slice);
  } catch (err) {
    return null;
  }
}

/**
 * 逐帧解析 + 逐帧解压，拼成文本。
 * 每帧的字节范围由 parseFrame 按帧结构算出（不扫 magic），只解单帧，所以绝不会把下一帧
 * 的内容吃进来（详见文件头的说明）。告警按文件汇总，避免刷屏：
 *   - 解不开的正常帧 → 计入 broken，汇总一句 "skipped N undecodable zstd frame(s)"；
 *   - 尾帧被物理截断 → 必告警（尾部少算），并用已完成块的前缀尽量补统计；
 *   - 中段损坏（帧头/块头非法）→ 告警带字节偏移，停止解析该文件（后面无法可靠定位）；
 *   - 偏移 0 就不是 zstd → 一条 "not a zstd frame"，notZstd=true。
 * 告警不直接写 stderr：按发生顺序放进 warnings，由调用方决定输出（usage-audit 原样逐条打印）。
 *
 * @param {Buffer} buf
 * @param {string} [label] 告警前缀（文件名/相对路径）
 * @returns {{text: string, notZstd: boolean, warnings: string[], broken: number, truncatedTail: boolean}}
 */
function decodeSessionLog(buf, label = '') {
  const totalBytes = buf.length;
  const chunks = [];
  const warnings = [];
  let offset = 0;
  let frames = 0;
  let broken = 0;
  let notZstd = false;
  let truncatedTail = false;

  // N3：偏移 0 处 4 字节既不是帧 magic 也不是 skippable → 整个文件不是 zstd。
  // 不足 4 字节同样不可能有 magic，归到同一结论（只发这一条）。
  if (totalBytes > 0) {
    const head = totalBytes >= 4 ? buf.readUInt32LE(0) : -1;
    const isFrame = head === ZSTD_MAGIC || (head >= SKIPPABLE_MAGIC_MIN && head <= SKIPPABLE_MAGIC_MAX);
    if (!isFrame) {
      notZstd = true;
      warnings.push(tag(label, `not a zstd frame (${totalBytes} bytes, no zstd magic); no content decoded`));
    }
  }

  while (!notZstd && offset < totalBytes) {
    const frame = parseFrame(buf, offset);

    if (frame.kind === FRAME_SKIPPABLE) {
      offset = frame.end;
      continue;
    }

    if (frame.kind === FRAME_TRUNCATED) {
      // 精确可知：帧结构在 buf 末尾之前没走完（而不是靠明文特征猜）。尽最大努力把已完成
      // 块里的内容纳入统计，尾部必然少算，所以这条告警不能省。
      const prefix = decodeTruncatedTail(buf.subarray(offset));
      if (prefix !== null && prefix.length > 0) chunks.push(prefix);
      truncatedTail = true;
      break;
    }

    if (frame.kind === FRAME_CORRUPT) {
      // 帧头/块头非法：从坏帧之后无法可靠定位帧边界，停下并保留已解析内容。
      // offset 可能是 0（第一个帧的帧头就坏了），此时已解析部分为空。
      warnings.push(
        tag(
          label,
          `corrupt zstd frame at byte offset ${offset} (${frame.detail}); stopped parsing this file, later frames are missing`
        )
      );
      break;
    }

    // 正常帧：只解这一帧自己的字节范围
    frames += 1;
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(offset, frame.end)));
    } catch (err) {
      broken += 1;
    }
    offset = frame.end;
  }

  if (broken > 0) {
    warnings.push(tag(label, `skipped ${broken} undecodable zstd frame(s) out of ${frames}`));
  }
  if (truncatedTail) {
    warnings.push(
      tag(
        label,
        'last zstd frame is truncated (physical EOF inside the frame); decoded the readable prefix, tail may be undercounted'
      )
    );
  }

  return { text: Buffer.concat(chunks).toString('utf8'), notZstd, warnings, broken, truncatedTail };
}

/**
 * 把日志明文切成事件。空行跳过；JSON 解析失败的行计入 badLines；解析出来但不是对象的
 * （null / 数字 / 字符串 / 布尔）跳过且不计坏行。数组算对象（沿用 usage-audit 原判据）。
 */
function parseEvents(text) {
  const events = [];
  let badLines = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (err) {
      badLines += 1; // 半行 / 非 JSON：跳过
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    events.push(event);
  }

  return { events, badLines };
}

/**
 * 读一个会话日志文件并解析：decodeSessionLog + parseEvents 的组合。
 * 文件读不到（不存在 / 权限）时**抛出**原始 fs 错误，由调用方决定怎么降级；坏帧 / 坏行
 * 不抛错，只体现在 warnings / badLines 里。
 *
 * @param {string} file
 * @param {string} [label] 告警前缀
 * @returns {{text: string, notZstd: boolean, warnings: string[], broken: number, truncatedTail: boolean, events: object[], badLines: number}}
 */
function readSessionFile(file, label = '') {
  const buf = fs.readFileSync(file);
  const decoded = buf.length === 0
    ? { text: '', notZstd: false, warnings: [], broken: 0, truncatedTail: false }
    : decodeSessionLog(buf, label);
  const parsed = parseEvents(decoded.text);
  return { ...decoded, events: parsed.events, badLines: parsed.badLines };
}

module.exports = {
  decodeSessionLog,
  parseEvents,
  readSessionFile,
  ZSTD_BLOCK,
  // 以下给 usage-audit.js 的运行时自检用，不属于稳定对外接口
  parseFrame,
  FRAME_OK,
};
