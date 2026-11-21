# IdleHub no servidor Linux (selfhost-01)

Passo a passo para o **Kevin** executar no selfhost-01 (Ubuntu 24.04, sem tela). Ninguém do time roda
estes comandos: vários exigem `sudo`.

**Como ler os comandos:**

- 🔒 **sudo**: o bloco tem comandos que exigem administrador. Todo comando que precisa de root começa
  literalmente com `sudo`.
- 👤 **como idlehub**: rode dentro do shell do usuário `idlehub` (passo 4), sem sudo.
- 💻 **no seu PC**: rode no computador de onde você vai ver a tela.

O que vai ficar montado:

| Peça | Onde | Por quê |
| --- | --- | --- |
| App instalado pelo `.deb` | `/opt/IdleHub/idlehub` (de root) | O pacote também instala o perfil AppArmor que o sandbox precisa no Ubuntu 24.04 |
| Usuário Linux `idlehub` | `/home/idlehub` (permissão 750) | Guarda os logins dos jogos e roda uma extensão de terceiros; fica separado do seu usuário e do projeto do cliente |
| Tela virtual + VNC (TigerVNC) | display `:1`, VNC em `127.0.0.1:5901` | Uma tela sem monitor; o VNC só escuta no próprio servidor |
| Dois serviços systemd | `idlehub-tela` e `idlehub` | Sobem sozinhos com o servidor e voltam se caírem |
| Acesso de fora | túnel SSH pela Tailscale | Nada de porta pública, firewall, domínio ou túnel público |

---

## Antes de começar: aviso honesto sobre o Pokeidle

- **O limite de 4 contas soma o servidor e o seu PC.** Os termos do Pokeidle permitem no máximo
  **4 contas por pessoa e aparelho**, com banimento permanente acima disso. As contas que você abrir no
  servidor e as que você usa no PC são todas suas, então contam juntas. Se o PC já tem 4 contas, o servidor
  não pode ter nenhuma conta do Pokeidle. O aviso do app conta só as telas **daquele** app: o IdleHub do
  servidor não enxerga o do PC, e vice-versa. Conferir a soma é com você.
- **O IP do servidor é de datacenter.** Para o jogo, o servidor sai na internet com um endereço de
  hospedagem, diferente do IP da sua casa. Sites e proteções como o Cloudflare costumam desconfiar mais
  desse tipo de IP (desafios, captchas, bloqueios), e a mesma conta aparecendo de dois IPs diferentes pode
  chamar atenção. Não sabemos como o Pokeidle trata isso: as regras que conferimos falam do limite de contas,
  não de IP. Na dúvida, pergunte ao jogo antes de mover contas para o servidor.

---

## 1. Pacotes do sistema 🔒 sudo

```bash
sudo apt update
sudo apt install --no-install-recommends tigervnc-standalone-server tigervnc-tools xauth binutils
```

- `tigervnc-standalone-server`: o `Xtigervnc`, que é a tela virtual e o servidor VNC num processo só.
- `tigervnc-tools`: o `tigervncpasswd`, para a senha do VNC.
- `xauth`: o "cookie" do display, para que só o usuário `idlehub` consiga abrir janelas na tela virtual
  (sem ele, qualquer usuário do servidor poderia espiar a tela ou digitar nela).
- `binutils`: traz o `ar`, que o electron-builder usa para fechar o `.deb` (passo 3). Sem ele o build para em
  "Need executable 'ar' to convert dir to deb".

As bibliotecas que o Electron usa (GTK, NSS etc.) já estão no servidor: em 21/11/2026 o `ldd` do binário do
Electron 45 não acusou nenhuma faltando. As que o `.deb` declara (`libnotify4`, `libxss1`, `xdg-utils`,
`libsecret-1-0`…) o `apt` instala sozinho no passo 3.

## 2. Usuário dedicado 🔒 sudo

```bash
sudo adduser --disabled-password --comment "IdleHub" idlehub
sudo ls -ld /home/idlehub          # esperado: drwxr-x--- idlehub idlehub
```

- Sem senha (`--disabled-password`): ninguém entra como `idlehub` pelo SSH; você chega nele com `sudo`.
- Fora do grupo `sudo`: o app nunca ganha administrador.
- Pasta pessoal com permissão 750 (padrão do Ubuntu 24.04): os outros usuários não leem os logins dos jogos,
  e o `idlehub` não lê `/home/kevin` (que também é 750), onde ficam o MausBot e o projeto do cliente.

## 3. Montar e instalar o IdleHub (.deb)

Montar o pacote, **como você (kevin), sem sudo**, no clone do repositório:

```bash
cd /home/kevin/projetos/idlehub/repo
git switch main && git pull
npm ci
rm -rf dist
npm run dist:linux               # gera dist/idlehub_<versão>_amd64.deb
```

Instalar 🔒 sudo:

```bash
sudo apt install ./dist/idlehub_*_amd64.deb
cat /etc/apparmor.d/idlehub                     # o perfil que o pacote instalou
sudo aa-status | grep idlehub                   # esperado: "idlehub" na lista de perfis carregados
```

O `apt` pode avisar que o download foi feito "unsandboxed as root" por o arquivo estar na sua pasta: é
esperado com arquivo local e não tem problema.

## 4. Senha do VNC e cookie da tela 👤 como idlehub

Entrar no shell do `idlehub` (🔒 sudo):

```bash
sudo -u idlehub -i
```

Dentro dele (👤 sem sudo):

```bash
mkdir -p ~/.vnc && chmod 700 ~/.vnc
tigervncpasswd ~/.vnc/passwd     # 6 a 8 caracteres (só os 8 primeiros valem); "n" para a senha só-leitura

touch ~/.Xauthority && chmod 600 ~/.Xauthority
xauth -f ~/.Xauthority add :1 . "$(mcookie)"
exit
```

A senha do VNC protege a tela contra outros programas **deste servidor**: o `127.0.0.1:5901` é alcançável
por qualquer processo local. Use uma senha só para isso.

## 5. Serviços 🔒 sudo

Crie `/etc/systemd/system/idlehub-tela.service` (por exemplo com `sudo nano`):

```ini
[Unit]
Description=IdleHub: tela virtual :1 (VNC so em 127.0.0.1:5901)
After=network.target

[Service]
User=idlehub
Group=idlehub
WorkingDirectory=/home/idlehub
ExecStart=/usr/bin/Xtigervnc :1 -geometry 1600x1000 -depth 24 \
  -interface 127.0.0.1 -localhost -rfbport 5901 \
  -SecurityTypes VncAuth -PasswordFile /home/idlehub/.vnc/passwd \
  -auth /home/idlehub/.Xauthority -nolisten tcp -AlwaysShared
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- `-interface 127.0.0.1 -localhost`: o VNC só aceita conexão do próprio servidor.
- `-nolisten tcp`: a tela virtual não abre porta X11 na rede; só o socket local.
- `-auth`: só quem tem o cookie do passo 4 (o `idlehub`) abre janelas nela.

E `/etc/systemd/system/idlehub.service`:

```ini
[Unit]
Description=IdleHub na tela virtual :1
Requires=idlehub-tela.service
After=idlehub-tela.service

[Service]
User=idlehub
Group=idlehub
WorkingDirectory=/home/idlehub
Environment=DISPLAY=:1
Environment=XAUTHORITY=/home/idlehub/.Xauthority
# Espera a tela virtual ficar pronta (até 30 s).
ExecStartPre=/bin/sh -c 'for i in $(seq 30); do [ -S /tmp/.X11-unix/X1 ] && exit 0; sleep 1; done; exit 1'
ExecStart=/opt/IdleHub/idlehub
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Subir a tela e conferir que o sandbox funciona **antes** de ligar o app (🔒 sudo):

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now idlehub-tela.service
ss -ltn | grep 5901                # esperado: só 127.0.0.1:5901 (nenhum 0.0.0.0 nem IP da Tailscale)

sudo -u idlehub env DISPLAY=:1 XAUTHORITY=/home/idlehub/.Xauthority /opt/IdleHub/idlehub --teste-fumaca
```

O teste de fumaça abre a janela com dados temporários, sem nenhum jogo e sem rede, e fecha sozinho. Esperado:
uma linha `IDLEHUB_FUMACA_OK {...}` e o comando terminando em alguns segundos. Linhas de erro de `dbus` são
normais num servidor sem sessão gráfica. Se aparecer
`The SUID sandbox helper binary was found, but is not configured correctly`, veja
[Problemas comuns](#problemas-comuns).

Ligar o app (🔒 sudo):

```bash
sudo systemctl enable --now idlehub.service
systemctl status idlehub idlehub-tela --no-pager
```

## 6. Ver a tela de outro computador 💻 no seu PC

Com a Tailscale ligada no PC, abra o túnel e deixe essa janela aberta:

```bash
ssh -N -L 127.0.0.1:5901:127.0.0.1:5901 kevin@selfhost-01
```

Os dois `127.0.0.1` importam: o da direita é o destino no servidor; o da esquerda faz o túnel escutar só no
próprio PC. Sem ele, a escuta no PC depende da opção `GatewayPorts` do SSH de lá e poderia aceitar conexões
de outras máquinas da sua rede.

(`selfhost-01` é o nome do servidor na Tailscale; o IP `100.x.y.z` dele também serve. No Windows, o `ssh`
já vem no PowerShell.) Depois, num visualizador VNC (TigerVNC Viewer, por exemplo), conecte em
`localhost:5901` com a senha do passo 4. O VNC trafega dentro do SSH, que trafega dentro da Tailscale:
nada fica exposto na internet. Se a porta 5901 do PC já estiver em uso, troque o primeiro número
(`-L 127.0.0.1:15901:127.0.0.1:5901`) e conecte em `localhost:15901`.

Os logins nos jogos você faz por essa tela, como faria no PC. Popups de login (Discord, Google) abrem como
janelas separadas na mesma tela.

## 7. Atualizar

No Linux o IdleHub **não se atualiza sozinho** (veja o README). Para pôr uma versão nova no servidor:

```bash
cd /home/kevin/projetos/idlehub/repo
git switch main && git pull && npm ci && rm -rf dist && npm run dist:linux
sudo apt install ./dist/idlehub_*_amd64.deb      # 🔒; mesma versão de antes? acrescente --reinstall
sudo systemctl restart idlehub                   # 🔒
```

Os dados (logins, abas, eventos) ficam em `/home/idlehub/.config/IdleHub/` e não são tocados pela troca de versão.

## 8. Parar 🔒 sudo

```bash
sudo systemctl stop idlehub idlehub-tela            # para agora
sudo systemctl disable idlehub idlehub-tela         # e não sobe mais no boot
```

Fechar a janela do app pelo VNC também encerra o app (sem reinício automático); para voltar:
`sudo systemctl start idlehub`.

## 9. Desinstalar 🔒 sudo

```bash
sudo systemctl disable --now idlehub idlehub-tela
sudo rm /etc/systemd/system/idlehub.service /etc/systemd/system/idlehub-tela.service
sudo systemctl daemon-reload
sudo apt remove idlehub                    # o pós-remoção descarrega e apaga /etc/apparmor.d/idlehub
sudo deluser --remove-home idlehub         # APAGA logins dos jogos, configurações, eventos e extensões
sudo apt remove tigervnc-standalone-server tigervnc-tools   # opcional
rm -rf /home/kevin/projetos/idlehub/repo/dist               # sem sudo: o .deb montado
```

Quer guardar a configuração antes? Copie `/home/idlehub/.config/IdleHub/config.json`, mas lembre que ele
contém a URL do webhook do Discord, que é segredo. Se quiser tirar também o `xauth` e o `binutils`, confira
antes se nada mais no servidor usa esses pacotes.

---

## Problemas comuns

**O app fecha logo ao abrir e o log (`sudo journalctl -u idlehub -n 50`) mostra
`The SUID sandbox helper binary was found, but is not configured correctly`.**
O perfil AppArmor não está carregado. Confira e recarregue (🔒 sudo):

```bash
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns   # 1 neste servidor
sudo aa-status | grep idlehub
sudo apparmor_parser -r /etc/apparmor.d/idlehub
```

Não "resolva" com `--no-sandbox` nem desligando a restrição (`sysctl ...=0`): veja o porquê abaixo.

**Tela preta no VNC.** `systemctl status idlehub` mostra se o app está rodando; se ele foi fechado, use
`sudo systemctl start idlehub`.

**Link "abrir no navegador" não abre nada.** O servidor não tem navegador; abra o link no seu PC.

## Por que o sandbox precisa do perfil AppArmor

O Electron (como o Chrome) isola as páginas num sandbox que, no Linux, usa *user namespaces*. O Ubuntu 24.04
só deixa um programa criar user namespaces sem ser root se ele tiver um perfil AppArmor com a regra `userns`
(`kernel.apparmor_restrict_unprivileged_userns=1`, ligado neste servidor). Sem o perfil, o Electron aborta
ao abrir em vez de rodar sem proteção. As saídas possíveis:

1. **Perfil AppArmor só para o binário do app (a escolhida).** O `.deb` do electron-builder 26 instala em
   `/etc/apparmor.d/idlehub` um perfil que libera só `userns` para `/opt/IdleHub/idlehub`, um caminho de root
   que o usuário `idlehub` não consegue trocar. É o mesmo formato que a documentação do Chromium recomenda.
   O CI confere isso a cada PR no Ubuntu 24.04: sem o perfil o app não abre (com o erro de sandbox do
   Chromium); com ele, abre e a janela principal informa que está em sandbox.
2. **`chrome-sandbox` com SUID de root.** Também funciona, mas é o mecanismo antigo, que o próprio Chromium
   considera um pouco mais fraco, e exige um binário setuid a mais no sistema.
3. **Desligar a restrição (`sysctl kernel.apparmor_restrict_unprivileged_userns=0`).** Tira uma proteção do
   servidor inteiro, que também roda o MausBot e o projeto do cliente. Não.
4. **`--no-sandbox`.** Tira o sandbox de todos os processos do app: janela principal, popups de login
   (Discord, Google) e processos auxiliares do Chromium. Não.

**Alcance do sandbox, para não haver surpresa:** a janela principal e os popups de login rodam em sandbox,
e o teste de fumaça exige isso. Já as **telas de jogo** rodam sem o sandbox do sistema (`sandbox: false` em
`src/main.js`, porque o preload delas carrega os plugins com `require`). Isso já era assim antes do modo
Linux, vale igual no Windows e não muda com este guia. Elas continuam com `contextIsolation` ligado e
`nodeIntegration` desligado, e o teste de fumaça não as abre. Por isso o usuário dedicado do passo 2 importa:
se uma página de jogo ou a extensão escapar do Chromium, ela fica restrita ao usuário `idlehub` e não alcança
seus arquivos nem o projeto do cliente.

Por que o servidor usa o `.deb`, e não `npm start` direto do código: o binário do Electron ficaria em
`node_modules`, numa pasta que o próprio usuário pode alterar, e o perfil liberaria `userns` para qualquer
coisa que ele pusesse ali. Rodar do código continua possível para desenvolvimento (veja o README).
