require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { Client, GatewayIntentBits, Events } = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

async function sendToN8n(payload) {
  const webhookToken = process.env.N8N_WEBHOOK_TOKEN;

  if (!webhookToken) {
    throw new Error("N8N_WEBHOOK_TOKEN is not configured.");
  }

  await axios.post(process.env.N8N_WEBHOOK_URL, payload, {
    headers: {
      "Content-Type": "application/json",
      "x-discord-key": webhookToken,
    },
    timeout: 30000,
  });
}

function parseOutcomeMessage(message) {
  const trimmedMessage = message.trim();
  const match = trimmedMessage.match(/^(\S+)\s+(\d+(?:\.\d+)?)\s+(.+)$/u);

  if (!match) {
    throw new Error(
      "Invalid outcome format. Use: <account> <amount> <description>",
    );
  }

  const [, account, amountText, description] = match;
  const amount = Number(amountText);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be a positive number.");
  }

  return {
    account,
    amount,
    description: description.trim(),
  };
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "receipt") {
    const image = interaction.options.getAttachment("image");
    const note = interaction.options.getString("note") || "";

    // Basic validation
    if (!image.contentType || !image.contentType.startsWith("image/")) {
      return interaction.reply({
        content: "Please upload a valid image file for the receipt.",
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: "Processing your receipt...",
      ephemeral: true,
    });

    try {
      const payload = {
        command: "receipt",
        receipt: {
          url: image.url,
          proxyUrl: image.proxyURL,
          name: image.name,
          size: image.size,
          contentType: image.contentType,
        },
        note,
        submittedAt: new Date().toISOString(),
      };

      await sendToN8n(payload);

      await interaction.followUp({
        content: "Receipt sent to processing workflow successfully.",
        ephemeral: true,
      });
    } catch (error) {
      console.error(
        "Error sending receipt to n8n:",
        error?.response?.data || error.message,
      );

      await interaction.followUp({
        content:
          "Failed to send receipt to processing workflow. Please try again.",
        ephemeral: true,
      });
    }

    return;
  }

  if (interaction.commandName === "out") {
    const message = interaction.options.getString("message", true);

    let parsedOutcome;

    try {
      parsedOutcome = parseOutcomeMessage(message);
    } catch (error) {
      return interaction.reply({
        content:
          'Invalid format. Use `/out message:"cash 12000 đi biển với team anh Sơn"`.',
        ephemeral: true,
      });
    }

    const { account, amount, description } = parsedOutcome;

    await interaction.reply({
      content: "Processing your outcome...",
      ephemeral: true,
    });

    try {
      const payload = {
        command: "out",
        outcome: {
          account,
          amount,
          description,
          originalMessage: message,
        },
        submittedAt: new Date().toISOString(),
      };

      await sendToN8n(payload);

      await interaction.followUp({
        content: `Outcome sent successfully: [account: ${account}] [amount: ${amount}] [description: ${description}]`,
        ephemeral: true,
      });
    } catch (error) {
      console.error(
        "Error sending outcome to n8n:",
        error?.response?.data || error.message,
      );

      await interaction.followUp({
        content: "Failed to send outcome. Please try again.",
        ephemeral: true,
      });
    }
  }
});

// Optional callback endpoint from n8n to send final result to a Discord channel or user
app.post("/n8n-result", async (req, res) => {
  try {
    const { userId, channelId, message } = req.body;

    if (channelId) {
      const channel = await client.channels.fetch(channelId);
      if (channel) {
        await channel.send(message || "Receipt processed.");
      }
    }

    // Optional: DM user
    if (userId) {
      const user = await client.users.fetch(userId);
      if (user) {
        await user.send(message || "Your receipt has been processed.");
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Error handling n8n callback:", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Callback server running on port ${process.env.PORT || 3000}`);
});

client.login(process.env.DISCORD_TOKEN);
