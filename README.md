# IdleHub

Painéis multi-conta para jogos idle de navegador, com alertas de shiny e drops raros e resumos periódicos no Discord.

## Rodar

Requer [Node.js](https://nodejs.org) 22 ou mais novo.

```bash
npm install
npm start
```

Testes: `npm test`. Log de diagnóstico: rode com `IDLEHUB_DEBUG=1` (o F12 abre o DevTools da interface).

## Como usar

- **Abas**: cada aba tem 4 telas, e cada tela é uma sessão independente (login próprio). Use `+` para criar uma aba, clique duplo no nome para renomear e `×` para fechar.
- **Telas**: `✎` muda o nome ou o endereço, `⟳` recarrega e `⤢` expande uma tela (clique de novo para voltar à grade).
- **Eventos** (coluna da direita, `☰` mostra ou oculta): shinies e drops raros de todas as abas. Clicar num evento leva à tela da conta. Uma bolinha laranja na aba indica um evento novo numa aba escondida.
- **Configurações** (`⚙`): URL do webhook do Discord, botões de teste, quais avisos enviar, intervalo do resumo automático e quais drops contam como raros.

As telas escondidas continuam rodando normalmente.

## Pokeidle

- Detecta **shinies capturados** (inclusive os chocados de ovo) e **drops raros de boss e hunt** da própria conta.
- O app só **lê** as mensagens que o servidor já envia ao jogo. Nada é enviado e a jogabilidade não muda.
- ⚠️ Os termos do Pokeidle permitem **no máximo 4 contas por pessoa e aparelho**. Acima disso o banimento é permanente. O app mostra um aviso se houver mais de 4 telas do Pokeidle abertas. Cada amigo deve rodar o app no próprio PC.

## Extensões do Chrome

O app já vem com a extensão [Hunt for PokeIdle](https://chromewebstore.google.com/detail/mhnplloljgchpfpcpbhmcokmnefodjnh), que mostra as melhores hunts por XP/h e ouro/h. Ela pode ser desligada em ⚙ Configurações › Extensões do Chrome.

- Na primeira abertura, o app baixa a extensão direto da Chrome Web Store e confere o SHA-256 informado pela loja. Depois ela fica em cache.
- A cada abertura, o app consulta a loja em segundo plano. Se houver versão nova, ela é baixada e passa a valer na **próxima** vez que o app abrir.
- O Electron só suporta parte das APIs de extensão. Extensões que só injetam scripts na página funcionam. Popup, `webRequest`, notificações e outras APIs não funcionam.
- Para incluir outra extensão, adicione o ID dela ao `CATALOG` em `src/extensions.js`.

## Adicionar outro jogo

1. Crie `src/plugins/<jogo>.js` seguindo `pokeidle.js`: `id`, `name`, `hosts`, `defaultUrl`, `rareItems`, `special` e `detect(mensagem, special)`.
2. `detect` recebe cada mensagem JSON do WebSocket do jogo e devolve eventos `{ type: 'shiny' | 'drop' | 'account', ... }`. Ela roda **dentro da página**, então não pode usar nada fora dos próprios parâmetros.
3. Registre o plugin em `src/plugins/index.js` e escreva testes em `test/`.

Sites sem plugin também funcionam nas telas, só que sem detecção de eventos.

## Onde ficam os dados

`%APPDATA%\idlehub\`: `config.json` (abas, telas e configurações), `events.json` (últimos 300 eventos), `Partitions\` (sessões e logins de cada tela) e `extensions\` (extensões baixadas da Chrome Web Store).
