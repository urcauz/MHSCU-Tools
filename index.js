import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import fs from "fs";
import express from "express";
import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
});

const PREFIX = "!";
const CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const SUGGESTIONS_CHANNEL_ID = process.env.SUGGESTIONS_CHANNEL_ID;
const WINNER_ROLE_ID = process.env.WINNER_ROLE_ID;
const DATA_FILE = "./leaderboard.json";

// -------------------- Leaderboard Data --------------------
let leaderboard = {};
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    leaderboard = raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error("❌ Failed to load leaderboard.json, starting fresh.", err);
    leaderboard = {};
  }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(leaderboard, null, 2));
}

// -------------------- Count Messages --------------------
client.on("messageCreate", (msg) => {
  if (msg.author.bot) return;
  if (!leaderboard[msg.author.id]) leaderboard[msg.author.id] = 0;
  leaderboard[msg.author.id]++;
  saveData();
});

// -------------------- Role Management --------------------
async function removeWinnerRole(guild) {
  try {
    const role = await guild.roles.fetch(WINNER_ROLE_ID);
    if (!role) return;
    for (const [, member] of role.members) {
      try {
        await member.roles.remove(WINNER_ROLE_ID);
        console.log(`✅ Removed winner role from ${member.user.tag}`);
      } catch (err) {
        console.error(`❌ Failed to remove role from ${member.user.tag}:`, err);
      }
    }
  } catch (err) {
    console.error("❌ Error removing winner role:", err);
  }
}

async function giveWinnerRole(guild, winnerId) {
  try {
    const member = await guild.members.fetch(winnerId);
    if (!member) return;
    await member.roles.add(WINNER_ROLE_ID);
    console.log(`✅ Gave winner role to ${member.user.tag}`);
  } catch (err) {
    console.error(`❌ Failed to give winner role to ${winnerId}:`, err);
  }
}

// -------------------- Leaderboard Function --------------------
async function sendLeaderboard() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) return;
  const guild = channel.guild;

  await removeWinnerRole(guild);

  const sorted = Object.entries(leaderboard)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sorted.length === 0) {
    await channel.send("No messages recorded this week!");
    return;
  }

  const medalEmojis = ["🥇", "🥈", "🥉"];
  const top3 = sorted
    .slice(0, 3)
    .map(([id, count], i) => `#${i + 1} <@${id}> with **${count}** messages ${medalEmojis[i]}`)
    .join("\n");
  const next7 = sorted
    .slice(3)
    .map(([id, count], i) => `#${i + 4} <@${id}> with **${count}** messages`)
    .join("\n");

  const top3Winners = sorted.slice(0, 3);
  let mentionMessage = "🎉 **This week's top winners:** ";
  if (top3Winners.length >= 1) mentionMessage += `🥇 <@${top3Winners[0][0]}>`;
  if (top3Winners.length >= 2) mentionMessage += ` 🥈 <@${top3Winners[1][0]}>`;
  if (top3Winners.length >= 3) mentionMessage += ` 🥉 <@${top3Winners[2][0]}>`;
  mentionMessage += " 🎉";

  const embed = new EmbedBuilder()
    .setTitle("🏆 Weekly Leaderboard Winners")
    .setColor("Blue")
    .setDescription(`${top3}\n\n${next7 || ""}\n\nThe leaderboard will now reset!`)
    .setImage(
      "https://media.discordapp.net/attachments/1420424697501192293/1420428275381178368/3c907b8f-7bc7-48d6-8f40-773308e211da.png?ex=68d55c6b&is=68d40aeb&hm=ceda1d988eaee48ee6c3c94059827cb8c5fcf1f94bf2e3eb4b17233b6fb4e00e&=&format=webp&quality=lossless&width=908&height=605"
    )
    .setFooter({
      text: `Leaderboard | ${new Date().toLocaleDateString(
        "en-GB"
      )} ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`,
    });

  // Send a single message with mentions + embed
  await channel.send({
    content: mentionMessage,
    embeds: [embed],
    allowedMentions: { parse: ["users"] },
  });

  if (sorted.length > 0) await giveWinnerRole(guild, sorted[0][0]);

  leaderboard = {};
  saveData();
}

// -------------------- Single Message Listener --------------------
if (!client.listeners("messageCreate").some((l) => l.name === "handleMessage")) {
  client.on("messageCreate", handleMessage);
}

async function handleMessage(msg) {
  if (msg.author.bot) return;

  // -------------------- Commands --------------------
  if (!msg.content.startsWith(PREFIX)) return;
  const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // --- Test Leaderboard ---
  if (command === "testlb") {
    if (!msg.member.permissions.has("Administrator")) return;
    await sendLeaderboard();
    await msg.react("✅").catch(() => {});
  }

  // --- Suggestion ---
  if (command === "suggestion") {
    const suggestionText = args.join(" ");
    if (!suggestionText) return;

    try {
      const suggestionsChannel = await client.channels.fetch(SUGGESTIONS_CHANNEL_ID);
      if (!suggestionsChannel) return;

      const embed = new EmbedBuilder()
        .setTitle("💡 New Suggestion")
        .setDescription(suggestionText)
        .setColor("Yellow")
        .setAuthor({
          name: msg.author.displayName || msg.author.username,
          iconURL: msg.author.displayAvatarURL(),
        })
        .setTimestamp()
        .setFooter({ text: `User ID: ${msg.author.id}` });

      const suggestionMsg = await suggestionsChannel.send({ embeds: [embed] });
      await suggestionMsg.react("<:GreenArrow:1420438634368077894>");
      await suggestionMsg.react("<:RedArrow:1420438637824311456>");

      await msg.react("✅"); // confirmation
      await msg.delete().catch(() => {});
    } catch (err) {
      console.error("❌ Error creating suggestion:", err);
    }
  }
}

// -------------------- Cron Job --------------------
cron.schedule("0 0 * * 0", () => sendLeaderboard());

// -------------------- Express Server --------------------
const app = express();
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(process.env.PORT || 3000, () => console.log("Uptime server running"));

// -------------------- Ready Event --------------------
client.once("clientReady", () => console.log(`✅ Logged in as ${client.user.tag}`));

client.login(process.env.TOKEN);
