/**
 * ============================================================
 *  宅建 AI自動弱点蓄積システム
 *  LINE Bot × Anthropic API × Notion API
 * ============================================================
 *  動作フロー:
 *   1. ユーザーが「問題」と送信 → ◯✕クイズを出題(クイックリプライ付き)
 *   2. ユーザーが ◯ / ✕ で解答(ボタンタップ or テキスト送信)
 *   3. 正解 → 褒めて次の問題へ誘導
 *   4. 不正解 → Anthropic APIが「噛み砕いた一言解説」を動的生成
 *              → Notionの弱点データベースに自動保存
 * ============================================================
 *  必要な環境変数 (.env / ホスティングの環境変数に設定):
 *   LINE_CHANNEL_SECRET        … LINE Developersのチャネルシークレット
 *   LINE_CHANNEL_ACCESS_TOKEN  … LINEのチャネルアクセストークン(長期)
 *   ANTHROPIC_API_KEY          … Anthropic APIキー (sk-ant-…)
 *   NOTION_API_KEY             … Notionインテグレーションシークレット (ntn_… / secret_…)
 *   NOTION_DATABASE_ID         … 保存先NotionデータベースのID
 *   ANTHROPIC_MODEL            … (任意) 省略時 claude-haiku-4-5-20251001
 *   PORT                       … (任意) 省略時 3000
 * ============================================================
 */

"use strict";

const express = require("express");
const crypto = require("crypto");
require("dotenv").config();

// ------------------------------------------------------------
// 環境変数
// ------------------------------------------------------------
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const NOTION_API_KEY = process.env.NOTION_API_KEY || "";
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || "";
const PORT = process.env.PORT || 3000;

// 起動時に設定漏れを警告(起動自体は止めない)
for (const [key, val] of Object.entries({
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  ANTHROPIC_API_KEY,
  NOTION_API_KEY,
  NOTION_DATABASE_ID,
})) {
  if (!val) console.warn(`[WARN] 環境変数 ${key} が未設定です。`);
}

// ------------------------------------------------------------
// 宅建 過去問ベース ◯✕問題バンク(本試験の改題)
//  answer: true = ◯が正解 / false = ✕が正解
//  point : AI解説生成の根拠として渡す「正確な論点」
// ------------------------------------------------------------
const QUESTIONS = [
  {
    id: "q001",
    category: "宅建業法",
    source: "宅建士証の更新(過去問改題)",
    text: "宅地建物取引士証の有効期間は5年であり、更新を受けようとする場合、原則として交付の申請前6か月以内に行われる法定講習を受講しなければならない。",
    answer: true,
    point: "宅建士証の有効期間は5年。更新時は申請前6か月以内の法定講習の受講が必要(宅建業法22条の2・22条の3)。",
  },
  {
    id: "q002",
    category: "宅建業法",
    source: "手付額の制限(過去問改題)",
    text: "宅地建物取引業者は、自ら売主となる宅地の売買契約において、代金の額の10分の2を超える額の手付を受領することができる。",
    answer: false,
    point: "業者が自ら売主となる場合、手付は代金の2割(10分の2)を超えて受領できない(宅建業法39条1項)。超える特約は無効。",
  },
  {
    id: "q003",
    category: "宅建業法",
    source: "クーリング・オフ(過去問改題)",
    text: "宅地建物取引業者が自ら売主となる売買契約において、買受けの申込みをした者がその業者の事務所で買受けの申込みをした場合、クーリング・オフによる申込みの撤回はできない。",
    answer: true,
    point: "事務所等で申込みをした場合はクーリング・オフ不可(宅建業法37条の2)。「申込みをした場所」で判定するのがポイント。",
  },
  {
    id: "q004",
    category: "権利関係",
    source: "制限行為能力者(過去問改題)",
    text: "未成年者が法定代理人の同意を得ずに行った土地の売買契約は、当然に無効である。",
    answer: false,
    point: "未成年者が同意なく行った契約は「無効」ではなく「取り消すことができる」(民法5条2項)。取消しまでは有効。",
  },
  {
    id: "q005",
    category: "権利関係",
    source: "不動産物権変動(過去問改題)",
    text: "不動産に関する物権の得喪及び変更は、登記をしなければ、原則として第三者に対抗することができない。",
    answer: true,
    point: "民法177条。不動産の物権変動は登記が対抗要件。ただし背信的悪意者には登記なしでも対抗できる点もセットで覚える。",
  },
  {
    id: "q006",
    category: "法令上の制限",
    source: "開発許可(過去問改題)",
    text: "市街化区域内において1,000㎡の開発行為を行おうとする場合、原則として都道府県知事の開発許可を受けなければならない。",
    answer: true,
    point: "市街化区域は原則1,000㎡以上の開発行為に許可が必要(都市計画法29条)。1,000㎡「ちょうど」も含まれる。",
  },
  {
    id: "q007",
    category: "法令上の制限",
    source: "建蔽率の緩和(過去問改題)",
    text: "建蔽率の限度が10分の8とされている地域内で、かつ防火地域内にある耐火建築物については、建蔽率の制限は適用されない。",
    answer: true,
    point: "建蔽率8/10の地域+防火地域+耐火建築物 → 建蔽率制限なし(100%)(建築基準法53条6項1号)。",
  },
  {
    id: "q008",
    category: "税・その他",
    source: "固定資産税(過去問改題)",
    text: "固定資産税の納税義務者は、原則として毎年4月1日現在において固定資産課税台帳に所有者として登録されている者である。",
    answer: false,
    point: "固定資産税の賦課期日は4月1日ではなく「1月1日」(地方税法359条)。1月1日時点の所有者が1年分を納税する。",
  },
  {
    id: "q009",
    category: "宅建業法",
    source: "営業保証金(過去問改題)",
    text: "宅地建物取引業者は、営業保証金を主たる事務所の最寄りの供託所に供託しなければならず、その額は主たる事務所につき1,000万円である。",
    answer: true,
    point: "営業保証金は主たる事務所の最寄りの供託所に供託。本店1,000万円・支店1か所につき500万円(宅建業法25条)。",
  },
  {
    id: "q010",
    category: "権利関係",
    source: "賃借権の無断譲渡(過去問改題)",
    text: "賃借人が賃貸人の承諾を得ずに賃借権を第三者に譲渡した場合、賃貸人は、いかなる場合でも賃貸借契約を解除することができる。",
    answer: false,
    point: "無断譲渡・転貸でも「背信行為と認めるに足りない特段の事情」があれば解除できない(判例)。「いかなる場合でも」が誤り。",
  },
];

function getQuestionById(id) {
  return QUESTIONS.find((q) => q.id === id) || null;
}

function getRandomQuestion(excludeId) {
  const pool = QUESTIONS.filter((q) => q.id !== excludeId);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ------------------------------------------------------------
// ユーザーごとの出題状態(テキストで◯✕を打つ場合に使用)
// ※ クイックリプライのボタン解答はpostbackに問題IDを埋め込む
//    ためステートレスに動作します。
// ------------------------------------------------------------
const sessions = new Map(); // userId -> { qid, askedAt }
const SESSION_TTL_MS = 60 * 60 * 1000; // 1時間

function setSession(userId, qid) {
  sessions.set(userId, { qid, askedAt: Date.now() });
  // 簡易クリーンアップ
  if (sessions.size > 5000) {
    const now = Date.now();
    for (const [k, v] of sessions) {
      if (now - v.askedAt > SESSION_TTL_MS) sessions.delete(k);
    }
  }
}

function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.askedAt > SESSION_TTL_MS) {
    sessions.delete(userId);
    return null;
  }
  return s;
}

// ------------------------------------------------------------
// 入力テキストの正規化(◯/✕ゆれ吸収)
// ------------------------------------------------------------
const MARU_WORDS = ["◯", "○", "〇", "まる", "マル", "o", "O", "ｏ", "Ｏ", "正しい"];
const BATSU_WORDS = ["✕", "×", "✗", "x", "X", "ｘ", "Ｘ", "ばつ", "バツ", "誤り", "誤っている"];
const START_WORDS = ["問題", "次", "次の問題", "出題", "スタート", "start", "クイズ", "もんだい"];

function classifyText(raw) {
  const t = (raw || "").trim();
  if (START_WORDS.includes(t)) return "start";
  if (MARU_WORDS.includes(t)) return "maru";
  if (BATSU_WORDS.includes(t)) return "batsu";
  return "other";
}

// ------------------------------------------------------------
// LINE Messaging API
// ------------------------------------------------------------
async function lineReply(replyToken, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[LINE] reply失敗 status=${res.status} body=${body}`);
  }
}

function quickReplyAnswerButtons(qid) {
  return {
    items: [
      {
        type: "action",
        action: {
          type: "postback",
          label: "◯ 正しい",
          data: `action=answer&qid=${qid}&choice=maru`,
          displayText: "◯",
        },
      },
      {
        type: "action",
        action: {
          type: "postback",
          label: "✕ 誤り",
          data: `action=answer&qid=${qid}&choice=batsu`,
          displayText: "✕",
        },
      },
    ],
  };
}

function quickReplyNextButton() {
  return {
    items: [
      {
        type: "action",
        action: {
          type: "postback",
          label: "▶ 次の問題",
          data: "action=next",
          displayText: "次の問題",
        },
      },
    ],
  };
}

function buildQuestionMessage(q) {
  return {
    type: "text",
    text: `📝【${q.category}】\n\n${q.text}\n\n正しければ「◯」、誤りなら「✕」で答えてね!`,
    quickReply: quickReplyAnswerButtons(q.id),
  };
}

// ------------------------------------------------------------
// Anthropic API: 噛み砕いた一言解説を動的生成
// ------------------------------------------------------------
async function generateAiExplanation(q, userChoice) {
  const userAnswerStr = userChoice ? "◯(正しい)" : "✕(誤り)";
  const correctAnswerStr = q.answer ? "◯(正しい)" : "✕(誤り)";

  const systemPrompt =
    "あなたは宅建(宅地建物取引士)試験の人気講師です。" +
    "宅建の過去問データをもとに、法律初心者でも一瞬で理解できる、噛み砕いた一言解説を動的に生成してください。" +
    "ルール: (1)120文字以内 (2)専門用語はできるだけ日常の言葉や例え話に置き換える " +
    "(3)受験生が二度と間違えないように覚え方のコツを必ず入れる (4)前置きや復唱は禁止。解説本文のみを出力する。";

  const userPrompt = [
    `■過去問(◯✕形式): ${q.text}`,
    `■分野: ${q.category}`,
    `■正解: ${correctAnswerStr}`,
    `■受験生の解答: ${userAnswerStr} ←間違えました`,
    `■正確な論点: ${q.point}`,
    "",
    "この受験生のための「一言解説」を生成してください。",
  ].join("\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[Anthropic] API失敗 status=${res.status} body=${body}`);
      return q.point; // フォールバック: 問題バンク内の論点をそのまま解説に
    }

    const data = await res.json();
    const text =
      data && Array.isArray(data.content)
        ? data.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("")
            .trim()
        : "";
    return text || q.point;
  } catch (err) {
    console.error("[Anthropic] 呼び出しエラー:", err);
    return q.point; // ネットワーク障害時もシステムを止めない
  }
}

// ------------------------------------------------------------
// Notion API: 弱点データベースへ自動保存
// ------------------------------------------------------------
async function saveWeaknessToNotion(q, userChoice, explanation) {
  // 日本時間の今日の日付 (YYYY-MM-DD)
  const todayJST = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Tokyo",
  });

  const payload = {
    parent: { database_id: NOTION_DATABASE_ID },
    icon: { type: "emoji", emoji: "📕" },
    properties: {
      問題文: {
        title: [{ text: { content: q.text.slice(0, 2000) } }],
      },
      カテゴリ: {
        select: { name: q.category },
      },
      出典: {
        rich_text: [{ text: { content: q.source } }],
      },
      ユーザーの解答: {
        select: { name: userChoice ? "◯" : "✕" },
      },
      正解: {
        select: { name: q.answer ? "◯" : "✕" },
      },
      AI一言解説: {
        rich_text: [{ text: { content: explanation.slice(0, 2000) } }],
      },
      日付: {
        date: { start: todayJST },
      },
      復習済み: {
        checkbox: false,
      },
    },
  };

  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[Notion] 保存失敗 status=${res.status} body=${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Notion] 呼び出しエラー:", err);
    return false;
  }
}

// ------------------------------------------------------------
// 解答の判定 → 解説生成 → Notion保存 → LINE返信
// ------------------------------------------------------------
async function handleAnswer(replyToken, userId, q, userChoice) {
  sessions.delete(userId); // 二重解答防止

  const isCorrect = userChoice === q.answer;

  if (isCorrect) {
    await lineReply(replyToken, [
      {
        type: "text",
        text: `⭕ 正解!! すばらしい!\n\n💡ポイント: ${q.point}\n\nこの調子で次もいこう💪`,
        quickReply: quickReplyNextButton(),
      },
    ]);
    return;
  }

  // 不正解 → AI解説生成 + Notion保存
  const explanation = await generateAiExplanation(q, userChoice);
  const saved = await saveWeaknessToNotion(q, userChoice, explanation);

  const savedNote = saved
    ? "📚 この問題はNotionの「弱点ノート」に自動保存したよ。あとで必ず復習しよう!"
    : "⚠️ Notionへの保存に失敗しました。環境変数とDB設定を確認してください。";

  await lineReply(replyToken, [
    {
      type: "text",
      text:
        `❌ 残念、不正解…!\n正解は「${q.answer ? "◯" : "✕"}」でした。\n\n` +
        `🤖 AI一言解説:\n${explanation}\n\n${savedNote}`,
      quickReply: quickReplyNextButton(),
    },
  ]);
}

async function sendNewQuestion(replyToken, userId, excludeQid) {
  const q = getRandomQuestion(excludeQid);
  setSession(userId, q.id);
  await lineReply(replyToken, [buildQuestionMessage(q)]);
}

// ------------------------------------------------------------
// LINEイベント処理
// ------------------------------------------------------------
async function handleEvent(event) {
  const userId =
    (event.source && event.source.userId) || "unknown-user";

  // 友だち追加時のあいさつ
  if (event.type === "follow") {
    await lineReply(event.replyToken, [
      {
        type: "text",
        text:
          "友だち追加ありがとう!🎉\n宅建◯✕クイズBotだよ。\n\n" +
          "「問題」と送ると過去問ベースの◯✕クイズを出題!\n" +
          "間違えた問題はAIが一言解説を作って、自動でNotionの弱点ノートに蓄積されるよ📚\n\n" +
          "さっそく「問題」と送ってみてね!",
      },
    ]);
    return;
  }

  // ボタンタップ(postback)
  if (event.type === "postback") {
    const params = new URLSearchParams(event.postback.data || "");
    const action = params.get("action");

    if (action === "next") {
      const prev = getSession(userId);
      await sendNewQuestion(event.replyToken, userId, prev ? prev.qid : null);
      return;
    }

    if (action === "answer") {
      const q = getQuestionById(params.get("qid"));
      const choice = params.get("choice"); // "maru" | "batsu"
      if (!q || (choice !== "maru" && choice !== "batsu")) {
        await lineReply(event.replyToken, [
          { type: "text", text: "問題情報が見つからなかったよ。「問題」と送って再開してね!" },
        ]);
        return;
      }
      await handleAnswer(event.replyToken, userId, q, choice === "maru");
      return;
    }
    return;
  }

  // テキストメッセージ(リッチメニューのテキスト送信もここに来る)
  if (event.type === "message" && event.message && event.message.type === "text") {
    const kind = classifyText(event.message.text);

    if (kind === "start") {
      await sendNewQuestion(event.replyToken, userId, null);
      return;
    }

    if (kind === "maru" || kind === "batsu") {
      const session = getSession(userId);
      if (!session) {
        await lineReply(event.replyToken, [
          {
            type: "text",
            text: "いま解答待ちの問題がないみたい🤔\n「問題」と送ると出題するよ!",
          },
        ]);
        return;
      }
      const q = getQuestionById(session.qid);
      if (!q) {
        sessions.delete(userId);
        await lineReply(event.replyToken, [
          { type: "text", text: "問題情報が見つからなかったよ。「問題」と送って再開してね!" },
        ]);
        return;
      }
      await handleAnswer(event.replyToken, userId, q, kind === "maru");
      return;
    }

    // その他のメッセージ → 使い方ガイド
    await lineReply(event.replyToken, [
      {
        type: "text",
        text:
          "📖 使い方\n・「問題」→ ◯✕クイズを出題\n・「◯」or「✕」→ 解答\n\n" +
          "間違えた問題はAI解説付きでNotionに自動保存されるよ!",
      },
    ]);
    return;
  }
}

// ------------------------------------------------------------
// Expressサーバー / Webhook
// ------------------------------------------------------------
const app = express();

// 署名検証のため生のリクエストボディを保持する
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// 署名検証(なりすましリクエストの排除)
function isValidSignature(req) {
  const signature = req.get("x-line-signature");
  if (!signature || !req.rawBody) return false;
  const hmac = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ヘルスチェック(Renderのスリープ対策の死活監視にも使える)
app.get("/", (req, res) => {
  res.status(200).send("宅建 AI弱点蓄積Bot は稼働中です 🟢");
});

// LINE Webhookエンドポイント
app.post("/webhook", async (req, res) => {
  if (!isValidSignature(req)) {
    return res.status(401).send("Invalid signature");
  }

  const events = (req.body && req.body.events) || [];

  // すべてのイベントを処理してから200を返す
  // (VercelなどのサーバーレスでもAI生成・Notion保存が中断されない)
  await Promise.all(
    events.map((event) =>
      handleEvent(event).catch((err) =>
        console.error("[Webhook] イベント処理エラー:", err)
      )
    )
  );

  res.status(200).send("OK");
});

// ローカル / Render では待ち受け、Vercelではエクスポートのみ
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 宅建 AI弱点蓄積Bot 起動: http://localhost:${PORT}`);
  });
}

module.exports = app;
