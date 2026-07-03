const AI_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const AI_API_KEY = process.env.DOUBAO_API_KEY || ''; // 通过环境变量设置
const AI_MODEL = 'doubao-seed-2-0-mini-260215';

class AIService {
  static async generateContent(prompt, imageData = null) {
    const input = [
      {
        role: 'user',
        content: []
      }
    ];

    if (imageData) {
      input[0].content.push({
        type: 'input_image',
        image_url: imageData
      });
    }

    input[0].content.push({
      type: 'input_text',
      text: prompt
    });

    try {
      const response = await fetch(AI_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: AI_MODEL,
          input: input
        })
      });

      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error.message);
      }

      return this.parseResponse(data);
    } catch (error) {
      console.error('AI Service Error:', error);
      throw error;
    }
  }

  static parseResponse(data) {
    const textContent = data.output?.text || 
                        data.choices?.[0]?.message?.content || 
                        '';
    
    return {
      rawText: textContent,
      topics: this.extractTopics(textContent),
      description: this.extractDescription(textContent)
    };
  }

  static extractTopics(text) {
    const topics = [];
    const regex = /#[\u4e00-\u9fa5\w]+/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (!topics.includes(match[0])) {
        topics.push(match[0]);
      }
    }
    return topics.slice(0, 5);
  }

  static extractDescription(text) {
    const lines = text.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.includes('#') && line.length > 10);
    
    return lines.slice(0, 3).join(' ').substring(0, 200);
  }

  static async generateVideoContent(videoName, customPrompt = null) {
    const prompt = customPrompt || this.getDefaultPrompt(videoName);
    return await this.generateContent(prompt);
  }

  static getDefaultPrompt(videoName) {
    return `请根据视频文件名"${videoName}"生成适合短视频平台的内容。

要求：
1. 分析视频文件名，推测视频可能的类型和内容
2. 生成3-5个热门话题标签（以#开头）
3. 生成一段吸引人的视频描述（50-100字）

请严格按照以下JSON格式返回：
{
  "topics": ["#话题1", "#话题2", "#话题3"],
  "description": "视频描述内容"
}`;
  }
}

module.exports = AIService;
