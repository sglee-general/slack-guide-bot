const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_TOKEN });

export default async function handler(req, res) {
  // 슬랙 재시도 방지 및 연결 확인
  if (req.headers['x-slack-retry-num']) return res.status(200).send("ok");
  if (req.body.type === 'url_verification') return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body.event;
  if (event && event.text && !event.bot_id) {
    const channel = event.channel;
    const question = event.text.replace(/<@.*>/, '').trim();

    try {
      // 1. 첫 반응 (슬랙에 즉시 응답)
      const initial = await postToSlack(channel, "📡 **비나우 AI 에이전트 가동: 가이드 맵을 정밀 분석 중입니다...**");
      const ts = initial.ts;

      // 2. 노션 '지도' 분석 (메인 페이지의 모든 하위 페이지 목록 가져오기)
      const rootId = process.env.NOTION_PAGE_ID;
      const subPages = await getNotionMap(rootId);
      
      // 3. AI가 질문에 맞는 페이지를 스스로 선택 (Agent 로직)
      const targetPageId = await decidePage(question, subPages);
      
      let knowledge = "";
      if (targetPageId) {
        // 4. [핵심] 선택된 페이지의 본문과 '표' 데이터를 싹 긁어옴
        knowledge = await getDeepContent(targetPageId);
      } else {
        // AI가 지도를 보고도 못 찾으면 일반 검색으로 최후 시도
        knowledge = await fallbackSearch(question);
      }

      // 5. 최종 답변 생성 (Gemini 1.5 Flash 사용)
      const finalAnswer = await askGeminiExpert(question, knowledge);

      // 6. 슬랙 메시지 업데이트
      await updateSlackMessage(channel, ts, finalAnswer);
      
      return res.status(200).send("ok");
    } catch (error) {
      console.error("에러:", error);
      return res.status(200).send("error");
    }
  }
  return res.status(200).send("ignored");
}

// 메인 페이지에서 하위 페이지 제목과 ID를 싹 가져오는 함수
async function getNotionMap(blockId) {
  const response = await notion.blocks.children.list({ block_id: blockId });
  return response.results
    .filter(b => b.type === 'child_page')
    .map(b => ({ id: b.id, title: b.child_page.title }));
}

// AI가 목차를 보고 어떤 페이지로 들어갈지 결정
async function decidePage(question, pages) {
  const mapList = pages.map(p => `- ${p.title} (ID: ${p.id})`).join("\n");
  const prompt = `사용자 질문: "${question}"\n\n아래 노션 가이드 목록 중 답변을 찾기에 가장 적합한 페이지의 ID만 골라줘. 없으면 "NONE"이라고 해.\n\n${mapList}`;
  
  const res = await callGemini(prompt);
  const match = res.match(/[a-f0-9-]{36}/);
  return match ? match[0] : null;
}

// [핵심] 페이지 내부의 모든 텍스트와 '표'를 긁어오는 함수
async function getDeepContent(blockId) {
  let content = "";
  const blocks = await notion.blocks.children.list({ block_id: blockId });
  
  for (const block of blocks.results) {
    const type = block.type;
    const value = block[type];
    
    // 일반 텍스트 추출
    if (value?.rich_text) {
      content += value.rich_text.map(t => t.plain_text).join("") + "\n";
    }
    // 표(Table) 내부 데이터 추출
    if (type === 'table') {
      const rows = await notion.blocks.children.list({ block_id: block.id });
      for (const row of rows.results) {
        if (row.type === 'table_row') {
          content += "| " + row.table_row.cells.map(cell => cell.map(t => t.plain_text).join(" ")).join(" | ") + " |\n";
        }
      }
    }
  }
  return content;
}

async function fallbackSearch(query) {
  const res = await notion.search({ query, page_size: 2 });
  if (res.results.length > 0) return await getDeepContent(res.results[0].id);
  return "";
}

async function callGemini(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function askGeminiExpert(question, context) {
  const prompt = `당신은 비나우(BENOW) 사내 지식 에이전트입니다. 아래 지식을 바탕으로 질문에 답하세요.
[지식 베이스]:
${context || "내용을 찾지 못했습니다."}

[질문]:
${question}

와이파이 비밀번호(PW), SSID, 공용폴더 경로 등 구체적인 정보가 있다면 누락 없이 답변하세요.`;
  return await callGemini(prompt);
}

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
