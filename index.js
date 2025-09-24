import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import fs from "fs";
import express from "express";
import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,            // Required for guild features
    GatewayIntentBits.GuildMessages,     // Required for message events
    GatewayIntentBits.MessageContent,    // Required to read message content
    GatewayIntentBits.GuildMembers,      // Required if you ever fetch members
    GatewayIntentBits.GuildPresences     // Required if you later track presences
  ],
});

const PREFIX = "!";
const CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID || "1399398636797825046"; // leaderboard channel ID
const SUGGESTIONS_CHANNEL_ID = process.env.SUGGESTIONS_CHANNEL_ID || "YOUR_SUGGESTIONS_CHANNEL_ID_HERE"; // suggestions channel ID
const WINNER_ROLE_ID = process.env.WINNER_ROLE_ID || "1420435350949728296"; // role for 1st place winner
const DATA_FILE = "./leaderboard.json";

// Load or create leaderboard data
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

// Save function
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(leaderboard, null, 2));
}

// Count messages
client.on("messageCreate", (msg) => {
  if (msg.author.bot) return;
  if (!leaderboard[msg.author.id]) leaderboard[msg.author.id] = 0;
  leaderboard[msg.author.id]++;
  saveData();
});

// Role management functions
async function removeWinnerRole(guild) {
  try {
    const role = await guild.roles.fetch(WINNER_ROLE_ID);
    if (!role) {
      console.log("⚠️ Winner role not found");
      return;
    }

    // Remove role from all members who have it
    const membersWithRole = role.members;
    for (const [memberId, member] of membersWithRole) {
      try {
        await member.roles.remove(WINNER_ROLE_ID);
        console.log(`✅ Removed winner role from ${member.user.tag}`);
      } catch (error) {
        console.error(`❌ Failed to remove role from ${member.user.tag}:`, error);
      }
    }
  } catch (error) {
    console.error("❌ Error in removeWinnerRole:", error);
  }
}

async function giveWinnerRole(guild, winnerId) {
  try {
    const member = await guild.members.fetch(winnerId);
    if (!member) {
      console.log("⚠️ Winner member not found");
      return;
    }

    await member.roles.add(WINNER_ROLE_ID);
    console.log(`✅ Gave winner role to ${member.user.tag}`);
  } catch (error) {
    console.error(`❌ Failed to give winner role to ${winnerId}:`, error);
  }
}

// Leaderboard sending function
async function sendLeaderboard() {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) return;

  const guild = channel.guild;

  // Remove winner role from previous week's winner
  await removeWinnerRole(guild);

  const sorted = Object.entries(leaderboard)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sorted.length === 0) {
    channel.send("No messages recorded this week!");
    return;
  }

  const medalEmojis = ["🥇", "🥈", "🥉"];

  // Top 3 with medals
  const top3 = sorted
    .slice(0, 3)
    .map(
      ([id, count], i) =>
        `#${i + 1} <@${id}> with **${count}** messages ${medalEmojis[i]}`
    )
    .join("\n");

  // Next 7
  const next7 = sorted
    .slice(3)
    .map(([id, count], i) => `#${i + 4} <@${id}> with **${count}** messages`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("🏆 Weekly Leaderboard Winners")
    .setColor("Blue")
    .setDescription(
      `${top3}\n\n${next7 || ""}\n\nThe leaderboard will now reset!`
    )
    .setImage("https://media.discordapp.net/attachments/1420424697501192293/1420428275381178368/3c907b8f-7bc7-48d6-8f40-773308e211da.png?ex=68d55c6b&is=68d40aeb&hm=ceda1d988eaee48ee6c3c94059827cb8c5fcf1f94bf2e3eb4b17233b6fb4e00e&=&format=webp&quality=lossless&width=908&height=605")
    .setFooter({
      text: `Leaderboard | ${new Date().toLocaleDateString("en-GB")} ${new Date().toLocaleTimeString(
        "en-GB",
        { hour: "2-digit", minute: "2-digit" }
      )}`,
    });

  // Send mention message for top 3 winners
  let mentionMessage = "🎉 **This week's top winners:** ";
  const top3Winners = sorted.slice(0, 3);
  
  if (top3Winners.length >= 1) mentionMessage += `🥇 <@${top3Winners[0][0]}>`;
  if (top3Winners.length >= 2) mentionMessage += ` 🥈 <@${top3Winners[1][0]}>`;
  if (top3Winners.length >= 3) mentionMessage += ` 🥉 <@${top3Winners[2][0]}>`;
  
  mentionMessage += " 🎉";

  // Send the mention message first
  await channel.send({
    content: mentionMessage,
    allowedMentions: { parse: ["users"] },
  });

  // Then send the embed
  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: ["users"] }, // ✅ ensures <@id> actually pings
  });

  // Give winner role to new #1
  if (sorted.length > 0) {
    const winnerId = sorted[0][0]; // Get the ID of the first place winner
    await giveWinnerRole(guild, winnerId);
  }

  // Reset weekly leaderboard
  leaderboard = {};
  saveData();
}

// Commands
client.on("messageCreate", async (msg) => {
  if (!msg.content.startsWith(PREFIX) || msg.author.bot) return;
  const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === "testlb") {
    // Check if user has administrator permissions
    if (!msg.member.permissions.has("Administrator")) {
      msg.reply("❌ Only administrators can use this command!");
      return;
    }
    
    await sendLeaderboard();
    msg.reply("✅ Test leaderboard sent!");
  }

  if (command === "suggestion") {
    const suggestionText = args.join(" ");
    
    if (!suggestionText) {
      msg.reply("❌ Please provide a suggestion! Usage: `!suggestion Your suggestion here`");
      return;
    }

    try {
      // Get the suggestions channel
      const suggestionsChannel = await client.channels.fetch(SUGGESTIONS_CHANNEL_ID);
      
      if (!suggestionsChannel) {
        msg.reply("❌ Suggestions channel not found! Please contact an administrator.");
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("💡 New Suggestion")
        .setDescription(suggestionText)
        .setColor("Yellow")
        .setAuthor({
          name: msg.author.displayName || msg.author.username,
          iconURL: msg.author.displayAvatarURL(),
        })
        .setTimestamp()
        .setFooter({
          text: `User ID: ${msg.author.id}`,
        });

      const suggestionMsg = await suggestionsChannel.send({
        embeds: [embed],
      });

      // Add up and down arrow reactions
      await suggestionMsg.react("<:pngwing:1420439461812240556>");
      await suggestionMsg.react("<:RedArrow:1420439464249004182>");

      // Confirm to user that suggestion was sent
      msg.reply(`✅ Your suggestion has been sent to ${suggestionsChannel}!`);

      // Delete the original command message to keep chat clean
      try {
        await msg.delete();
      } catch (error) {
        console.log("⚠️ Couldn't delete command message (missing permissions)");
      }

    } catch (error) {
      console.error("❌ Error creating suggestion:", error);
      msg.reply("❌ Failed to create suggestion. Please try again.");
    }
  }
});

// Run every Sunday at 00:00 (12 AM)
cron.schedule("0 0 * * 0", () => {
  sendLeaderboard();
});

// Express server for UptimeRobot
const app = express();
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(process.env.PORT || 3000, () =>
  console.log("Uptime server running")
);

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.TOKEN);