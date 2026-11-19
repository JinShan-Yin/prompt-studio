/**
 * v1.61 知识库 Markdown 本地切片器（纯 Node.js，不调用大模型）
 *
 * 能力：
 *  1. 按 Markdown 标题（# ~ ######，重点 ## / ###）切块；
 *  2. 双重熔断：单块 > 1500 字符先按段落（双换行）二次切分，仍超限则按字符强切；
 *  3. 表格感知分片：大表格按数据行拆成多个「子表 + 对应自然语言」单元（try/catch 容错，
 *     非标准表格保留原文），自然语言内联在每个子表末尾，优化 RAG 召回
 *     （如「中環店的電話是 3100 2002」），同时保证每个入库块 <= 1500 字符。
 *
 * 导出：parseMarkdownChunks(rawText) -> [{ question, answer }]
 */

export const MAX_MD_CHUNK_LEN = 1500;
const NO_TITLE_QUESTION_LEN = 20;

/* ------------------------------------------------------------------ *
 * 第一步：按标题切块
 * ------------------------------------------------------------------ */
function splitByHeadings(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const headingRe = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
  const blocks = [];
  let current = { heading: '', level: 0, lines: [] };

  const flush = () => {
    if (current.lines.length > 0 || current.heading) blocks.push(current);
  };

  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      flush();
      current = { heading: m[2].trim(), level: m[1].length, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------------------ *
 * 第二步：双重熔断（段落二次切分 + 字符强切）
 * ------------------------------------------------------------------ */
function fuseByLength(text, limit) {
  if (text.length <= limit) return [text];
  const paragraphs = text.split(/\n[ \t]*\n/);
  const pieces = [];
  let buf = '';

  const pushBuf = () => {
    if (buf.length > 0) { pieces.push(buf); buf = ''; }
  };

  for (let paragraph of paragraphs) {
    // 单个段落本身超长：先结算已有缓冲，再对该段按字符强切
    while (paragraph.length > limit) {
      pushBuf();
      pieces.push(paragraph.slice(0, limit));
      paragraph = paragraph.slice(limit);
    }
    const candidate = buf ? `${buf}\n\n${paragraph}` : paragraph;
    if (candidate.length > limit) pushBuf();
    buf = buf ? `${buf}\n\n${paragraph}` : paragraph;
  }
  pushBuf();
  return pieces.filter((p) => p.length > 0);
}

/* ------------------------------------------------------------------ *
 * 第三步：Markdown 表格解析与自然语言
 * ------------------------------------------------------------------ */

// 字段 key -> 中文标签（未命中则回退把下划线转空格）
const FIELD_LABELS = {
  store_id: '编号', store_name: '店名', store_name_en: '英文店名', district: '所在区域',
  store_type: '门店类型', store_address: '地址', store_phone_local: '电话', store_email: '邮箱',
  map_link: '地图链接', transfer_number: '转接号码', business_hours: '营业时间',
  supports_takeaway: '是否支持自取', supports_delivery: '是否支持配送', menu_available: '菜单类型',
  item_id: '编号', item_name: '名称', item_name_en: '英文名称', category: '类别',
  price_hkd: '价格', 價: '价格', 類別: '类别', 供應分店: '供应分店', 售罄狀態: '售罄状态',
  customer_phone: '电话', customer_name: '客户姓名', customer_email: '邮箱', order_total: '订单总额',
};

function fieldLabel(key) {
  const k = String(key || '').trim();
  if (FIELD_LABELS[k]) return FIELD_LABELS[k];
  return k.replace(/[_\-]+/g, ' ');
}

function cleanCell(cell) {
  return String(cell == null ? '' : cell)
    .replace(/`/g, '')
    .replace(/\\\|/g, '|')
    .replace(/\*\*/g, '')
    .trim();
}

function splitTableRow(line) {
  let s = String(line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(cleanCell);
}

function isSeparatorRow(row) {
  return row.length > 0 && row.every((c) => /^:?-{2,}:?$/.test(String(c).replace(/\s/g, '')));
}

/** 转置表：第一列是字段、表头是实体（分店）。nameMapByCol 提供全表店名映射。 */
function transposedToSentences(header, bodyRows, nameMapByCol) {
  const sentences = [];
  const nameRow = bodyRows.find((r) => r[0] === 'store_name');
  const entityNameByCol = {};
  if (nameMapByCol) Object.assign(entityNameByCol, nameMapByCol);
  if (nameRow) {
    for (let j = 1; j < header.length; j++) {
      entityNameByCol[j] = nameRow[j] || `${cleanCell(header[j])}店`;
    }
  }
  for (const row of bodyRows) {
    const key = row[0];
    if (key === 'store_name') continue; // 店名本身即主语，无需造句
    for (let j = 1; j < header.length; j++) {
      const value = row[j];
      if (!value) continue;
      const subject = entityNameByCol[j] || `${cleanCell(header[j])}店`;
      if (key === 'store_phone_local') {
        sentences.push(`${subject}的电话是 ${value}`);
      } else {
        sentences.push(`${subject}的${fieldLabel(key)}是 ${value}`);
      }
    }
  }
  return sentences;
}

/** 普通记录表：每行一个实体，表头是字段；以名称字段为主语，其余字段补充说明。 */
function normalToSentences(header, bodyRows) {
  const sentences = [];
  const nameColIdx = header.findIndex((h) => /name|名称|店名/.test(h));
  for (const row of bodyRows) {
    const subject = nameColIdx >= 0 ? row[nameColIdx] : row[0];
    if (!subject) continue;
    const parts = [];
    for (let j = 0; j < header.length; j++) {
      if (j === nameColIdx) continue;
      const value = row[j];
      if (!value) continue;
      const key = header[j];
      if (key === 'item_id' || /^id$/i.test(key)) {
        parts.push(`编号为 ${value}`);
      } else if (key === 'store_phone_local' || key === 'customer_phone') {
        parts.push(`电话是 ${value}`);
      } else {
        parts.push(`${fieldLabel(key)}是 ${value}`);
      }
    }
    sentences.push(parts.length ? `${subject}的${parts.join('，')}` : subject);
  }
  return sentences;
}

/**
 * 表格感知分片：把文本拆成若干 segment（{ type:'text'|'table', value }）。
 * - 非表格内容原样保留；
 * - 标准表格按数据行拆成多个「子表 + 内联自然语言」单元，每个单元 <= limit；
 * - 非标准表格（解析失败）整体作为文本保留，绝不抛错。
 */
function splitTablesWithInlineNL(text, limit) {
  const lines = String(text).split(/\r?\n/);
  const segments = [];
  let textBuf = [];
  let tableBuf = [];

  const flushText = () => {
    if (textBuf.length) {
      segments.push({ type: 'text', value: textBuf.join('\n') });
      textBuf = [];
    }
  };

  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.map(splitTableRow);
    const sepIdx = rows.findIndex(isSeparatorRow);
    if (sepIdx <= 0) {
      // 非标准/无法解析：容错，原文保留
      segments.push({ type: 'text', value: tableBuf.join('\n') });
      tableBuf = [];
      return;
    }
    const headerLine = tableBuf[sepIdx - 1];
    const headerCells = rows[sepIdx - 1];
    const sepLine = tableBuf[sepIdx];
    const dataIdxs = [];
    for (let i = sepIdx + 1; i < tableBuf.length; i++) {
      if (rows[i].some((c) => c)) dataIdxs.push(i);
    }

    const firstCol = dataIdxs.map((i) => rows[i][0]);
    const isTransposed = firstCol.some((v) => v === 'store_name') || /字段|分組|分组/.test(headerCells[0] || '');

    // 转置表：先从全表提取店名映射，保证不含 store_name 的子组也能拿到准确主语
    let globalNameMap = null;
    if (isTransposed) {
      const nameRow = dataIdxs.map((i) => rows[i]).find((r) => r[0] === 'store_name');
      if (nameRow) {
        globalNameMap = {};
        for (let j = 1; j < headerCells.length; j++) {
          globalNameMap[j] = nameRow[j] || `${cleanCell(headerCells[j])}店`;
        }
      }
    }

    const buildSentences = (subRows) => {
      try {
        return isTransposed
          ? transposedToSentences(headerCells, subRows, globalNameMap)
          : normalToSentences(headerCells, subRows);
      } catch {
        return [];
      }
    };

    const emitGroup = (group) => {
      if (!group.length) return;
      const subTable = [headerLine, sepLine, ...group.map((i) => tableBuf[i])].join('\n');
      const sentences = buildSentences(group.map((i) => rows[i]));
      const value = sentences.length ? `${subTable}\n\n${sentences.join('\n')}` : subTable;
      segments.push({ type: 'table', value });
    };

    // 按数据行累积，预估「子表 + 自然语言」长度，超 limit 就开新组
    let group = [];
    for (const idx of dataIdxs) {
      const trial = [...group, idx];
      const trialSub = [headerLine, sepLine, ...trial.map((i) => tableBuf[i])].join('\n');
      const trialSent = buildSentences(trial.map((i) => rows[i]));
      const trialLen = trialSub.length + (trialSent.length ? 2 + trialSent.join('\n').length : 0);
      if (group.length && trialLen > limit) {
        emitGroup(group);
        group = [idx];
      } else {
        group = trial;
      }
    }
    emitGroup(group);
    tableBuf = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('|')) {
      flushText();
      tableBuf.push(line);
    } else {
      flushTable();
      textBuf.push(line);
    }
  }
  flushTable();
  flushText();
  return normalizeSegments(segments, limit);
}

/**
 * 规整原始 segments：
 *  - 丢弃纯空白段（消除空块）；
 *  - 表格前的文本（标题）前置到下一个表格；
 *  - 表格后的短文本在不超限时后置到该表格，连续文本相互合并；
 *  - 合并后仍可能超限的文本保持独立，交由主入口 fuseByLength 兜底。
 */
function normalizeSegments(rawSegments, limit) {
  const out = [];
  for (const seg of rawSegments) {
    const isText = seg.type === 'text';
    const value = isText ? seg.value.replace(/\s+$/, '') : seg.value;
    if (isText && !value.trim()) continue;

    if (isText) {
      const last = out[out.length - 1];
      if (last && last.type === 'table' && last.value.length + 2 + value.length <= limit) {
        last.value = `${last.value}\n\n${value}`;
      } else if (last && last.type === 'text') {
        last.value = `${last.value}\n\n${value}`;
      } else {
        out.push({ type: 'text', value });
      }
    } else {
      const last = out[out.length - 1];
      if (last && last.type === 'text') {
        out.pop();
        out.push({ type: 'table', value: `${last.value}\n\n${value}` });
      } else {
        out.push({ type: 'table', value });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */
export function parseMarkdownChunks(rawText, limit = MAX_MD_CHUNK_LEN) {
  const text = String(rawText == null ? '' : rawText);
  if (!text.trim()) return [];
  const result = [];

  for (const block of splitByHeadings(text)) {
    const blockText = block.lines.join('\n');
    // 表格感知分片（子表 + 内联自然语言），再对每个 segment 做通用熔断兜底
    const segments = splitTablesWithInlineNL(blockText, limit);
    const blockPieces = [];
    for (const seg of segments) {
      blockPieces.push(...fuseByLength(seg.value, limit));
    }
    blockPieces.forEach((piece, idx) => {
      let question = block.heading;
      if (!question) {
        const plain = piece.replace(/^#{1,6}[ \t]+/, '').replace(/\s+/g, ' ').trim();
        question = plain.slice(0, NO_TITLE_QUESTION_LEN);
      } else if (blockPieces.length > 1) {
        question = `${question}（${idx + 1}/${blockPieces.length}）`;
      }
      result.push({ question, answer: piece });
    });
  }
  return result;
}

export default { parseMarkdownChunks, MAX_MD_CHUNK_LEN };
