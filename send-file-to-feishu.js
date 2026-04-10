#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Lark = require('@larksuiteoapi/node-sdk');

// 配置信息 - 请填写你自己的飞书应用信息
const config = {
  appId: 'YOUR_APP_ID',      // 替换为你的 APP ID
  appSecret: 'YOUR_APP_SECRET',  // 替换为你的 APP Secret
  chatId: 'YOUR_CHAT_ID',    // 替换为你要发送到的聊天 ID
  domain: 'feishu'
};

// 要发送的文件
const filePath = path.resolve(__dirname, 'src/session-manager.ts');

async function sendFile() {
  console.log('正在发送文件:', filePath);

  try {
    // 创建飞书客户端
    const client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: config.domain
    });

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    console.log('文件大小:', stats.size, '字节');

    // 上传文件
    console.log('正在上传文件...');
    const uploadResult = await client.im.file.create({
      data: {
        file_type: 'stream',
        file_name: path.basename(filePath),
        file: fs.createReadStream(filePath)
      }
    });

    const fileKey = uploadResult.data?.file_key;
    if (!fileKey) {
      throw new Error('文件上传失败，未返回 file_key');
    }
    console.log('文件上传成功，file_key:', fileKey);

    // 发送文件消息
    console.log('正在发送消息...');
    const messageResult = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: config.chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey })
      }
    });

    console.log('文件发送成功! 消息ID:', messageResult.data?.message_id);

  } catch (error) {
    console.error('发送失败:', error.message);
    if (error.code) {
      console.error('错误代码:', error.code);
    }
    if (error.data?.msg) {
      console.error('详细信息:', error.data.msg);
    }
  }
}

// 运行发送任务
sendFile().catch(console.error);
