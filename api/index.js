import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 슬랙 재시도 방지
  if (req.headers['x-slack-retry-num']) {
    return res.status(200).send("ok");
  }

  // 슬랙 URL 인증
  if (req.body.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  const event = req.body.event;

  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    
    // ✅ 슬랙 3초 제한 대응 (먼저 응답)
    res.status(200).send("ok");

    (async () => {
      try {
        const channel = event.channel;
        const question = event.text.replace(/<@.*>/, '').trim();

        console.log("🙋 질문:", question);

        // 1. 초기 응답
        const initialRes = await postToSlack(channel, "🔍 노션 전체 데이터를 스캔해서 답변 준비 중입니다...");
        const ts = initialRes.ts;

        // 2. 전체 노션 데이터 수집
        const context = await getAllNotionContent();

        console.log("📚 수집된 데이터 길이:", context.length);

        // 3. AI 질문
        const answer = await askAIAgent(question, context);

        // 4. 슬랙 업데이트
        await updateSlackMessage(channel, ts, answer);

      } catch (error) {
        console.error("❌ 에러:", error);
      }
    })();
  }
}

//////////////////////////////
// 🔍 Notion 전체 크롤링
//////////////////////////////

async function getAllNotionContent() {
  try {
    const searchRes = await notion.search({
      filter: { value: "page", property: "object" },
      page_size: 20
    });

    let fullText = "";

    for (const page of searchRes.results) {
      const title = getPageTitle(page);

      const content = await getBlockText(page.id);

      fullText += `\n\n[페이지 제목: ${title}]\n${content}`;
    }

    return fullText || "노션에서 데이터를 읽지 못했습니다.";

  } catch (error) {
    console.error("❌ Notion 전체 조회 실패:", error);
    return "노션 API 오류 발생";
  }
}

//////////////////////////////
// 🔁 블록 재귀 탐색
//////////////////////////////

async function getBlockText(blockId) {
  let text = "";

  try {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100
    });

    for (const block of res.results) {
      const type = block.type;
      const richText = block[type]?.rich_text || [];

      const plain = richText.map(t => t.plain_text).join("");

      if (plain) {
        text += plain + "\n";
      }

      // 🔥 핵심: 자식 블록 재귀 탐색
      if (block.has_children) {
        text += await getBlockText(block.id);
      }
    }

  } catch (error) {
    console.error("❌ 블록 조회 실패:", error);
  }

  return text;
}

//////////////////////////////
// 🏷 페이지 제목 추출
//////////////////////////////

function getPageTitle(page) {
  try {
    const properties = page.properties;

    for (const key in properties) {
      if (properties[key].type === "title") {
        return properties[key].title.map(t => t.plain_text).join("");
      }
    }

    return "제목 없음";
  } catch {
    return "제목 없음";
  }
}

//////////////////////////////
// 🤖 AI 호출 (Gemini)
//////////////////////////////

async function askAIAgent(question, context) {
  const prompt = `
당신은 회사 내부 업무 가이드를 답변하는 AI입니다.

[노션 데이터]
${context}

[질문]
${question}

[답변 규칙]
1. 반드시 노션 데이터 기반으로만 답변
2. wifi / 와이파이 같은 유사어는 동일하게 판단
3. 정보가 있으면 정확하게 그대로 전달
4. 없으면 "업무 가이드에서 찾을 수 없습니다."라고 답변
`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await res.json();

    return data.candidates?.[0]?.content?.parts?.[0]?.text
      || "🤔 AI가 답변을 생성하지 못했습니다.";

  } catch (error) {
    console.error("❌ AI 오류:", error);
    return "AI 응답 중 오류 발생";
  }
}

//////////////////////////////
// 💬 Slack 전송
//////////////////////////////

async function postToSlack(channel, text) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ channel, text })
  });

  return await res.json();
}

async function updateSlackMessage(channel, ts, text) {
  await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ channel, ts, text })
  });
}
