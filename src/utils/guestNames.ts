/**
 * Random display name generator for guest players.
 * Format: <Adjective><Noun><Number>
 *
 * ~200 adjectives × ~200 nouns = 40,000+ combos before the number suffix.
 * With a 2-digit suffix (00–99), that gives 4,000,000+ unique names.
 */

const ADJECTIVES: string[] = [
  // Tactical / chess-flavored
  'Bold', 'Silent', 'Swift', 'Clever', 'Sneaky', 'Brave', 'Sharp', 'Cunning',
  'Fierce', 'Agile', 'Witty', 'Mighty', 'Daring', 'Vigilant', 'Ruthless',
  'Stealthy', 'Iron', 'Golden', 'Silver', 'Crystal',
  // Nature
  'Arctic', 'Amber', 'Azure', 'Crimson', 'Cobalt', 'Ember', 'Frost', 'Jade',
  'Lunar', 'Misty', 'Obsidian', 'Onyx', 'Prism', 'Raven', 'Rustic', 'Sage',
  'Scarlet', 'Shadow', 'Solar', 'Storm', 'Tidal', 'Violet', 'Whispering', 'Wild',
  // Fun / quirky
  'Chaotic', 'Cosmic', 'Cryptic', 'Digital', 'Electric', 'Frozen', 'Glowing',
  'Hyper', 'Infinite', 'Invisible', 'Laser', 'Magnetic', 'Neon', 'Noble',
  'Phantom', 'Quantum', 'Radiant', 'Rapid', 'Rebel', 'Rogue', 'Sonic',
  'Spectral', 'Stellar', 'Sublime', 'Turbo', 'Ultra', 'Vivid', 'Wandering', 'Zephyr',
];

const NOUNS: string[] = [
  // Chess pieces & terms
  'Knight', 'Bishop', 'Rook', 'Queen', 'King', 'Pawn', 'Gambit', 'Checkmate',
  'Endgame', 'Blitz', 'Castle', 'Fork', 'Pin', 'Skewer',
  // Animals
  'Wolf', 'Fox', 'Bear', 'Tiger', 'Falcon', 'Hawk', 'Eagle', 'Dragon',
  'Phoenix', 'Cobra', 'Panther', 'Lynx', 'Orca', 'Viper', 'Mantis',
  'Hornet', 'Jaguar', 'Raptor', 'Stallion', 'Kraken',
  // Mythological / epic
  'Titan', 'Specter', 'Wraith', 'Oracle', 'Sage', 'Warden', 'Sentinel',
  'Nomad', 'Ranger', 'Paladin', 'Duelist', 'Templar', 'Arcanist',
  'Cipher', 'Slayer', 'Harbinger', 'Seraph', 'Drifter', 'Champion', 'Warlord',
  // Tech / sci-fi
  'Pixel', 'Nova', 'Quasar', 'Nexus', 'Vector', 'Axiom', 'Cipher', 'Drone',
  'Matrix', 'Pulse', 'Signal', 'Vertex', 'Vortex', 'Zenith', 'Helix',
];

/**
 * Returns a random guest display name like "SilentKnight42" or "CosmicFalcon08".
 */
export function generateGuestName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 100).toString().padStart(2, '0');
  return `${adj}${noun}${num}`;
}
