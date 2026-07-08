/**
 * cartography/blockColors.js — Approximate Minecraft "map colors" for rendering Xaero
 * terrain. Not pixel-perfect vanilla map colors, but tuned so natural terrain reads
 * naturally (green grass, grey stone, blue water, red netherrack) and player-placed
 * blocks (wool/concrete/terracotta/glass) pop — which is what matters for spotting bases.
 */

const DYE = {
  white: [233, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179], light_blue: [58, 175, 217],
  yellow: [248, 198, 39], lime: [112, 185, 25], pink: [237, 141, 172], gray: [62, 68, 71],
  light_gray: [142, 142, 134], cyan: [21, 119, 136], purple: [121, 42, 172], blue: [53, 57, 157],
  brown: [114, 71, 40], green: [84, 109, 27], red: [160, 39, 34], black: [20, 21, 25],
};

function dyeColor(n) {
  for (const k of Object.keys(DYE)) if (n.includes(k + '_') || n.includes('_' + k)) return DYE[k];
  return null;
}

const EXACT = {
  'minecraft:water': [55, 90, 220], 'minecraft:lava': [224, 90, 12],
  'minecraft:grass_block': [95, 156, 53], 'minecraft:stone': [122, 122, 122],
  'minecraft:netherrack': [105, 42, 42], 'minecraft:bedrock': [70, 70, 74],
  'minecraft:obsidian': [20, 18, 30], 'minecraft:crying_obsidian': [40, 20, 70],
  'minecraft:air': [16, 16, 22], 'minecraft:cave_air': [16, 16, 22],
};

/** Block id (e.g. "minecraft:stone") → [r,g,b]. */
function colorOf(name) {
  if (!name) return [60, 62, 70];
  if (EXACT[name]) return EXACT[name];
  const n = name;
  // Player-placed / colored first, so bases stand out.
  if (/_wool|_carpet|_concrete\b|_concrete_powder|_terracotta|_glazed_terracotta|_stained_glass|_bed\b|_banner|_shulker_box|_candle/.test(n)) {
    const d = dyeColor(n); if (d) return d;
  }
  if (/water|bubble/.test(n)) return [55, 90, 220];
  if (/lava/.test(n)) return [224, 90, 12];
  if (/snow|powder_snow/.test(n)) return [245, 247, 250];
  if (/packed_ice|blue_ice/.test(n)) return [140, 170, 235];
  if (/\bice\b|frosted_ice/.test(n)) return [160, 185, 240];
  if (/grass|moss|_leaves|vine|fern|lily|kelp|seagrass|bamboo|sugar_cane|azalea/.test(n)) return [85, 150, 50];
  if (/sand\b|sandstone|smooth_sand/.test(n)) return [219, 211, 160];
  if (/red_sand/.test(n)) return [190, 102, 50];
  if (/dirt|podzol|farmland|coarse|rooted|mud\b|mycelium|path/.test(n)) return [132, 96, 66];
  if (/clay/.test(n)) return [159, 164, 177];
  if (/gravel|tuff|cobblestone|andesite|stone_brick|smooth_stone|furnace|dispenser|brick|grindstone|cauldron|anvil/.test(n)) return [120, 120, 124];
  if (/diorite|quartz|calcite|white_concrete|polished_diorite/.test(n)) return [224, 224, 226];
  if (/granite/.test(n)) return [149, 103, 85];
  if (/deepslate|gilded_blackstone|blackstone|basalt|gabbro/.test(n)) return [54, 54, 60];
  if (/_log|_wood|_planks|_stem|_hyphae|crafting_table|bookshelf|barrel|chest|loom|lectern|composter|scaffolding|ladder|note_block|jukebox|beehive|cartography|fletching|smithing|wooden/.test(n)) return [157, 127, 79];
  if (/nether_brick|nether_wart_block|crimson|warped_wart|nether_gold|magma/.test(n)) return /warped/.test(n) ? [30, 110, 105] : [110, 40, 45];
  if (/soul_sand|soul_soil|soul/.test(n)) return [78, 62, 50];
  if (/glowstone|sea_lantern|shroomlight|ochre_froglight|verdant_froglight|pearlescent|lantern|torch|beacon|sea_pickle/.test(n)) return [205, 185, 95];
  if (/sculk/.test(n)) return [13, 40, 48];
  if (/prismarine|dark_prismarine/.test(n)) return [85, 160, 150];
  if (/end_stone|end_/.test(n) || /purpur|chorus/.test(n)) return [221, 223, 165];
  if (/glass/.test(n)) return [185, 222, 226];
  if (/ore\b/.test(n)) return [124, 124, 128];
  if (/copper/.test(n)) return [180, 110, 80];
  if (/iron_block|anvil|iron_bars|rail/.test(n)) return [200, 200, 205];
  if (/gold_block/.test(n)) return [246, 208, 62];
  if (/diamond_block/.test(n)) return [110, 220, 215];
  if (/emerald_block/.test(n)) return [80, 200, 110];
  if (/netherite/.test(n)) return [60, 54, 56];
  if (/tnt/.test(n)) return [180, 50, 40];
  if (/mushroom|fungus/.test(n)) return [150, 90, 80];
  const d = dyeColor(n); if (d) return d;
  return [110, 110, 116];
}

module.exports = { colorOf, DYE };
