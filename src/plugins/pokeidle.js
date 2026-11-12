'use strict';

// Plugin do Pokeidle (https://pokeidle.io).
// O jogo recebe do servidor mensagens JSON por WebSocket. As que interessam:
//   { t: 'welcome', estado: {...} }               -> login concluído
//   { t: 'batalha', ev: [ { k: '...', ... } ] }   -> eventos de batalha
//     k 'capturado'  + pokemon.shiny            -> shiny capturado
//     k 'ovoChocou'  + pokemon.shiny            -> shiny chocado de ovo
//     k 'morte' quem 'selvagem' + drops[]       -> drops de hunt
//     k 'bossMorto' + drops[]                   -> drops de boss
// O app só LÊ essas mensagens; nada é enviado ao jogo.

const RARE_ITEMS = [
  { id: 70014, name: 'Mega Stone Fragment', where: 'Boss', defaultOn: true },
  { id: 70015, name: 'Mega Shiny Stone Fragment', where: 'Boss', defaultOn: true },
  { id: 59194, name: 'TM Disk Piece', where: 'Boss', defaultOn: true },
  { id: 40530, name: 'AoE TM Disk Piece', where: 'Boss', defaultOn: true },
  { id: 70090, name: 'Mystic Ticket', where: 'Boss', defaultOn: true },
  { id: 70095, name: 'Safari Ticket', where: 'Boss', defaultOn: true },
  { id: 70000, name: 'Bronze Boss Token', where: 'Hunt Outland', defaultOn: false },
  { id: 70011, name: 'Key Fragment', where: 'Hunt Outland', defaultOn: true },
  { id: 70012, name: 'Shiny Stone Fragment', where: 'Hunt Outland', defaultOn: true },
  { id: 70013, name: 'Bicycle Fragment', where: 'Hunt Outland', defaultOn: true },
  { id: 70017, name: 'Shiny Egg Fragment', where: 'Hunt Unova', defaultOn: true },
];

// IMPORTANTE: esta função é serializada (toString) e roda dentro da página do
// jogo. Ela não pode usar nada de fora dela: tudo chega pelos parâmetros.
// `special` é um objeto { [itemId]: nome }.
function detect(m, special) {
  const out = [];
  if (!m || typeof m !== 'object') return out;

  if (m.t === 'welcome') {
    const st = m.estado || {};
    const nick = (st.eu && st.eu.nick) || st.nick || (m.eu && m.eu.nick) || m.nick;
    if (nick) out.push({ type: 'account', nick: String(nick) });
    return out;
  }

  if (m.t !== 'batalha' || !Array.isArray(m.ev)) return out;

  for (const e of m.ev) {
    if (!e || typeof e !== 'object') continue;

    if ((e.k === 'capturado' || e.k === 'ovoChocou') && e.pokemon && e.pokemon.shiny) {
      out.push({
        type: 'shiny',
        name: String(e.pokemon.nome || '?'),
        level: e.pokemon.level != null ? Number(e.pokemon.level) : null,
        quality: e.pokemon.quality != null ? e.pokemon.quality : null,
        source: e.k === 'ovoChocou' ? 'ovo' : 'captura',
      });
    }

    const isHunt = e.k === 'morte' && e.quem === 'selvagem' && !e.safari;
    const isBoss = e.k === 'bossMorto';
    if ((isHunt || isBoss) && Array.isArray(e.drops)) {
      for (const d of e.drops) {
        const id = Number(d && d.itemId);
        const qty = Number(d && d.qtd) || 0;
        if (qty > 0 && special[id]) {
          out.push({
            type: 'drop',
            itemId: id,
            item: special[id],
            qty,
            from: isBoss ? 'boss' : 'hunt',
            source: String(e.nome || (isBoss ? 'Boss' : 'selvagem')),
          });
        }
      }
    }
  }
  return out;
}

module.exports = {
  id: 'pokeidle',
  name: 'Pokeidle',
  hosts: ['pokeidle.io'],
  defaultUrl: 'https://pokeidle.io/app',
  accountLimit: 4,
  rareItems: RARE_ITEMS,
  special: Object.fromEntries(RARE_ITEMS.map((i) => [i.id, i.name])),
  detect,
};
