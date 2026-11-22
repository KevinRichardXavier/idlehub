# IdleHub

Painéis multi-conta para jogos idle de navegador, com alertas de shiny e drops raros e resumos periódicos no Discord.

## Rodar

Requer [Node.js](https://nodejs.org) 22 ou mais novo.

```bash
npm install
npm start
```

Testes: `npm test`. O CI (GitHub Actions, `.github/workflows/ci.yml`) roda `npm ci` e `npm test` em Windows e Linux a cada push na `main` e em cada pull request, com o Node da versão em `.nvmrc`. Log de diagnóstico: rode com `IDLEHUB_DEBUG=1` (o F12 abre o DevTools da interface).

**Teste de fumaça**: `npm run fumaca` (ou `idlehub --teste-fumaca` no app instalado) abre a janela principal com dados numa pasta temporária e com a rede bloqueada, confere que a interface montou, abre **uma** tela de jogo apontada para uma página local de teste (`idlehub-fumaca://`, que só existe nesse modo; nenhum jogo é aberto) e fecha sozinho. Imprime `IDLEHUB_FUMACA_OK` e sai com código 0 se passou; `IDLEHUB_FUMACA_FALHOU` e código 1 se não. Ele não envia nada ao Discord e reprova se o sandbox do Chromium estiver desligado, se a janela principal ou a tela de jogo não estiverem em sandbox com `contextIsolation`, se a página da tela enxergar `require`/`process`, ou se o preload da tela não tiver resolvido o plugin, instalado o observador na página e entregado um evento da página ao processo principal. Depois ele testa o proxy com servidores locais de teste: um proxy `http` com senha (a tela precisa carregar por ele, com o WebRTC em `disable_non_proxied_udp`, e a senha não pode aparecer na saída nem no `config.json`), o "Testar proxy", um `socks5`, um proxy fora do ar e uma senha errada (a tela precisa ficar sem conexão nos dois casos) e, ao fim, confere que nenhuma tela saiu direto. O CI roda esse teste no Ubuntu 24.04 sob tela virtual (`xvfb-run`), do código e do `.deb` instalado, e guarda uma captura da janela como artefato `fumaca-linux`.

### Linux

`npm start` funciona no Linux com uma tela (física ou virtual). No Ubuntu 23.10 ou mais novo (inclusive 24.04), o sistema só deixa o sandbox do Chromium funcionar para programas com um perfil AppArmor; sem ele o app fecha ao abrir com `The SUID sandbox helper binary was found, but is not configured correctly`. Para rodar do código, crie um perfil para o Electron do projeto (precisa de sudo, uma vez por clone; refaça se o caminho do clone mudar):

```bash
node scripts/perfil-apparmor.js | sudo tee /etc/apparmor.d/idlehub-codigo
sudo apparmor_parser -r /etc/apparmor.d/idlehub-codigo
```

O perfil só libera a criação de *user namespaces* para o binário do Electron daquele clone. Não use `--no-sandbox` nem desligue a restrição do sistema. Para remover: `sudo apparmor_parser -R /etc/apparmor.d/idlehub-codigo && sudo rm /etc/apparmor.d/idlehub-codigo`.

Pacote: `npm run dist:linux` gera `dist/idlehub_<versão>_amd64.deb` (precisa do `ar`, do pacote `binutils`). O `.deb` instala o app em `/opt/IdleHub/` e já instala e carrega o próprio perfil AppArmor (`/etc/apparmor.d/idlehub`); ao desinstalar, o perfil sai junto.

Para deixar o IdleHub rodando num servidor sem tela e vê-lo de outro computador (pela Tailscale), siga [docs/servidor-linux.md](docs/servidor-linux.md).

## Instalar e atualizar

- **Windows**: `npm run dist` gera o instalador (`IdleHub-Setup-<versão>.exe`). O app instalado se atualiza sozinho pelos GitHub Releases: baixa a versão nova em segundo plano, avisa na interface e instala ao reiniciar.
- **Linux**: a atualização é **manual**. O app não procura versões novas. Para atualizar, gere e instale o `.deb` novo (`sudo apt install ./dist/idlehub_*_amd64.deb`) ou, rodando do código, `git pull` e `npm ci`. Motivos: atualizar um `.deb` exige root (o atualizador pediria a senha, o que não funciona num servidor sem tela) e os releases não publicam o pacote Linux.
- Rodando do código (`npm start`) o app nunca se atualiza sozinho, em nenhum sistema.

## Como usar

- **Abas**: cada aba tem 4 telas, e cada tela é uma sessão independente (login próprio). Use `+` para criar uma aba, clique duplo no nome para renomear e `×` para fechar.
- **Telas**: `✎` muda o nome ou o endereço, `⟳` recarrega e `⤢` expande uma tela (clique de novo para voltar à grade).
- **Eventos** (coluna da direita, `☰` mostra ou oculta): shinies e drops raros de todas as abas. Clicar num evento leva à tela da conta. Uma bolinha laranja na aba indica um evento novo numa aba escondida.
- **Configurações** (`⚙`): URL do webhook do Discord, botões de teste, quais avisos enviar, intervalo do resumo automático, [proxy](#proxy) e quais drops contam como raros.

As telas escondidas continuam rodando normalmente.

## Pokeidle

- Detecta **shinies capturados** (inclusive os chocados de ovo) e **drops raros de boss e hunt** da própria conta.
- O app só **lê** as mensagens que o servidor já envia ao jogo. Nada é enviado e a jogabilidade não muda.
- ⚠️ Os termos do Pokeidle permitem **no máximo 4 contas por pessoa e aparelho**. Acima disso o banimento é permanente. O app mostra um aviso se houver mais de 4 telas do Pokeidle abertas. Cada amigo deve rodar o app no próprio PC. Se você também rodar o IdleHub num servidor, as contas de lá somam com as do seu PC: o aviso de cada app só conta as telas dele (veja [docs/servidor-linux.md](docs/servidor-linux.md)).

## Proxy

Em ⚙ Configurações › Proxy dá para fazer as telas de jogo saírem na internet por um proxy (por exemplo, um proxy residencial pago, quando o jogo bloqueia IP de datacenter). É **um proxy para o app todo**, não um por conta.

- **Campos**: ligar/desligar, tipo (`http`, `https` ou `socks5`), host (nome ou IP, sem `http://` e sem usuário), porta e, opcionalmente, usuário e senha. `https` é TLS até o próprio proxy; use se o provedor oferecer.
- **Onde vale**: todas as telas de jogo, de todas as abas, inclusive os popups de login (Discord/Google), que usam a sessão da própria tela. O proxy é aplicado na sessão **antes** de a tela carregar o jogo.
- **Mudar com o app aberto**: ao salvar uma mudança no proxy, o app aplica a regra nova em todas as sessões, derruba as conexões abertas pela rota antiga e recarrega todas as telas. Não precisa reiniciar.
- **Sem vazamento**: com o proxy ligado, a regra das sessões é só aquele proxy, sem conexão direta como alternativa. Se o proxy cair, recusar a senha ou estiver configurado errado, as telas ficam **sem conexão** (erro do Chromium ou uma página "sem conexão" do app); nunca saem pelo IP direto. O WebRTC das telas fica em `disable_non_proxied_udp` (sem UDP fora do proxy). No `socks5` o DNS também é resolvido pelo proxy. Só endereços da própria máquina (`localhost`, `127.0.0.1`) não passam pelo proxy.
- **Usuário e senha**: no `http` e no `https` o app responde ao pedido de login do proxy (evento `login` do Electron), só para o host e a porta configurados e no máximo 5 vezes por minuto por tela, para senha errada não virar laço; nesse caso aparece um aviso no topo. **`socks5` com usuário e senha não funciona**: o Chromium não suporta autenticação em SOCKS5 ([net/docs/proxy.md](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)), e a tela recusa salvar essa combinação. Use o endereço `http`/`https` do provedor ou libere o IP da máquina no painel dele e deixe usuário e senha vazios.
- **Testar proxy**: usa o que está no formulário (antes de salvar), numa sessão temporária só do teste, e mostra o IP de saída visto por `ipinfo.io` (ou `api.ipify.org`, se o primeiro falhar), com cidade e provedor quando houver. Se der erro, mostra o motivo (proxy fora do ar, senha recusada, tempo esgotado...).
- **O que sai direto, sem o proxy**: o webhook do Discord, a checagem de atualização (só Windows) e o download de extensões da Chrome Web Store. Motivos: esses serviços não bloqueiam IP de datacenter; o tráfego do proxy residencial é pago; os avisos no Discord continuam chegando se o proxy cair; e a URL do webhook, que é segredo, não passa por um terceiro. As extensões, depois de carregadas, rodam dentro das telas e usam o proxy delas.
- **A senha**: fica presa ao proxy em que foi digitada (tipo, host, porta e usuário, gravados junto dela). Ao mudar qualquer um desses, a tela pede a senha de novo, e nem o login das telas nem o "Testar proxy" mandam a senha salva para outro servidor, nem se o `config.json` for editado à mão. Ela nunca aparece de novo na tela (o campo fica vazio; deixar vazio mantém a salva, e há a opção "Apagar a senha salva"), nunca vai para logs, mensagens de erro ou Discord, e não fica no `config.json`. Ela fica em `proxy-senha.json` na [pasta de dados](#onde-ficam-os-dados), com permissão 600:
  - Windows, macOS e Linux com chaveiro (GNOME Keyring/KWallet): criptografada pelo `safeStorage` do Electron (DPAPI, Keychain ou o chaveiro).
  - Linux sem chaveiro (o servidor sem tela): o `safeStorage` cairia no modo `basic_text`, cuja chave é fixa no código do Chromium e não protege nada. Por isso o app guarda a senha só em base64, **que não é criptografia**: a proteção real é a permissão 600 na pasta pessoal do usuário que roda o app. A tela de configurações diz qual dos dois modos está em uso.
- **Regras do Pokeidle**: o proxy não muda nenhum limite. A seção 5 dos [termos](https://pokeidle.io/terms) (conferidos em 22/11/2026) limita 4 contas por pessoa, somando todas as redes e aparelhos, e 4 contas criadas e 4 conectadas ao mesmo tempo por rede; contas usadas para contornar o limite por rede podem ser banidas, e desde 16/11/2026 o jogo não libera mais redes. Por isso o proxy é um só para o app todo (todas as telas saem pela mesma rede), nunca um por conta, e o aviso de mais de 4 telas do Pokeidle continua igual. Proxy não é jeito de contornar bloqueio do jogo: só use se o suporte tiver liberado o seu caso. Prefira um IP fixo (sticky ou estático), de preferência dedicado: IP residencial rotativo ou compartilhado pode ter contas de outras pessoas somando no limite daquela rede.
- **Proxy ligado e inválido**: se o `config.json` tiver um proxy ligado que o app não entende (tipo desconhecido, host ou porta inválidos), ele fica marcado como inválido e as telas ficam sem conexão até você corrigir e salvar em ⚙ Configurações › Proxy, mesmo depois de reiniciar.

## Extensões do Chrome

O app já vem com a extensão [Hunt for PokeIdle](https://chromewebstore.google.com/detail/mhnplloljgchpfpcpbhmcokmnefodjnh), que mostra as melhores hunts por XP/h e ouro/h. Ela pode ser desligada em ⚙ Configurações › Extensões do Chrome.

- Na primeira abertura, o app baixa a extensão direto da Chrome Web Store e confere o SHA-256 informado pela loja. Depois ela fica em cache.
- A cada abertura, o app consulta a loja em segundo plano. Se houver versão nova, ela é baixada e passa a valer na **próxima** vez que o app abrir.
- O Electron só suporta parte das APIs de extensão. Extensões que só injetam scripts na página funcionam. Popup, `webRequest`, notificações e outras APIs não funcionam.
- O teste de fumaça não baixa nem carrega extensões.
- Para incluir outra extensão, adicione o ID dela ao `CATALOG` em `src/extensions.js`.

## Adicionar outro jogo

1. Crie `src/plugins/<jogo>.js` seguindo `pokeidle.js`: `id`, `name`, `hosts`, `defaultUrl`, `rareItems`, `special` e `detect(mensagem, special)`.
2. `detect` recebe cada mensagem JSON do WebSocket do jogo e devolve eventos `{ type: 'shiny' | 'drop' | 'account', ... }`. Ela roda **dentro da página**, então não pode usar nada fora dos próprios parâmetros.
3. Registre o plugin em `src/plugins/index.js` e escreva testes em `test/`.

As telas de jogo rodam com `sandbox: true`, `contextIsolation` ligado e `nodeIntegration` desligado (`src/panel-prefs.js`). Num preload em sandbox o `require` só conhece o `electron`, então o preload das telas (`src/preload-panel.js`) e tudo o que ele carrega (registro, plugins e observador) é montado num arquivo só, `src/gerado/preload-panel.js`, por `scripts/montar-preload.js`. Isso roda sozinho antes de `npm start`, `npm test`, `npm run fumaca`, `npm run dist`, `npm run dist:linux` e `npm run release` (ou à mão: `npm run montar`). O arquivo gerado não é versionado e o `npm test` reprova se ele estiver diferente do que as fontes geram. Por isso, num plugin ou no preload: só `require('./caminho-fixo')` de arquivos de `src/` ou `require('electron')`; a montagem recusa qualquer outro módulo (`fs`, `path`...) e `require` com nome variável.

Sites sem plugin também funcionam nas telas, só que sem detecção de eventos.

## Onde ficam os dados

- Windows: `%APPDATA%\IdleHub\`
- Linux: `~/.config/IdleHub/` (ou `$XDG_CONFIG_HOME/IdleHub/`, se essa variável estiver definida). No servidor do guia, `/home/idlehub/.config/IdleHub/`.

Dentro dela: `config.json` (abas, telas e configurações, sem a senha do proxy), `proxy-senha.json` (senha do proxy, se houver; veja [Proxy](#proxy)), `events.json` (últimos 300 eventos), `Partitions\` (sessões e logins de cada tela) e `extensions\` (extensões baixadas da Chrome Web Store).
