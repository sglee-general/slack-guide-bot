const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && !event.bot_id && (event.type === 'app_mention' || event.channel_type === 'im')) {
    res.status(200).send("ok");

    try {
      const channel = event.channel;
      const question = event.text.replace(/<@.*>/, '').trim();

      // 1. 첫 반응 (봇이 살아있음을 알림)
      const initialRes = await postToSlack(channel, "🔍 해당 내용이 적힌 노션 페이지를 정밀 스캔 중입니다...");
      const ts = initialRes.ts;

      // 2. [핵심] 검색 결과에서 '내용'을 긁어오는 로직을 대폭 강화
      const context = await getFullContentFromNotion(question);
      
      console.log("📝 수집된 지식 내용:", context);

      // 3. AI에게 지식 전달 (이때 AI가 wifi와 와이파이를 매칭함)
      const answer = await askAIAgent(question, context);

      // 4. 답변 업데이트
      await updateSlackMessage(channel, ts, answer);
    } catch (error) {
      console.error("❌ 에러:", error);
    }
  }
}

async function getFullContentFromNotion(query) {
  try {
    // 제목뿐만 아니라 본문 단어까지 포함된 페이지들을 찾습니다.
    const searchRes = await notion.search({
      query: query,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 5
    });

    let combinedKnowledge = "";

    for (const page of searchRes.results) {
      if (page.object === 'page') {
        // [강화] 해당 페이지의 모든 블록(텍스트, 표, 리스트 등)을 하나도 빠짐없이 읽음
        const blocks = await notion.blocks.children.list({ block_id: page.id });
        
        const extractedText = blocks.results.map(block => {
          const type = block.type;
          // 노션의 다양한 블록 형태(문단, 리스트, 제목, 콜아웃, 표 등)에서 텍스트만 추출
          const textData = block[type]?.rich_text || block[type]?.text || [];
          return textData.map(t => t.plain_text).join("");
        }).filter(t => t.length > 0).join("\n");

        combinedKnowledge += `[페이지 제목: ${page.id}]\n${extractedText}\n\n`;
      }
    }
    return combinedKnowledge || "노션에서 텍스트 데이터를 읽어오지 못했습니다. 봇의 페이지 접근 권한을 확인해주세요.";
  } catch (e) { return "노션 API 오류 발생"; }
}

async function askAIAgent(question, context) {
  const prompt = `당신은 비나우(BENOW) 업무지원팀 AI 에이전트입니다. 
제공된 [노션 가이드 데이터]에서 사용자의 질문에 대한 답을 찾아 친절하게 설명하세요.

[노션 가이드 데이터]
${context}

[사용자 질문]
${question}

[답변 원칙]
1. 데이터에 와이파이 비밀번호나 주차 방법 같은 구체적인 정보가 있다면 그대로 전달하세요.
2. 질문과 데이터의 단어가 조금 달라도(예: wifi-와이파이) 문맥상 같으면 답변하세요.
3. 만약 데이터가 비어있다면 "해당 페이지에 접근 권한이 없거나 내용이 없습니다."라고 안내하세요.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "🤔 내용을 찾았으나 AI가 답변을 구성하지 못했습니다.";
}

// 슬랙 함수 (기존과 동일)
async function postToSlack(channel, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, text })
  });
  return await res.json();
}

async function updateSlackMessage(channel, ts, text) {
  await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, ts, text })
  });
}
