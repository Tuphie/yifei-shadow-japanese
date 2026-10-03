navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
  s.getTracks().forEach((t) => t.stop());
  document.getElementById('msg').innerHTML = '<span class="ok">✓ 已授权。</span><br>可以关闭这个页面，回到侧边栏按 M 开始录音。';
  setTimeout(() => window.close(), 2500);
}).catch((e) => {
  document.getElementById('msg').innerHTML = '<span class="err">没有拿到麦克风权限：' + e.message + '</span><br>请点地址栏左侧的图标，把「麦克风」改为允许，然后刷新本页。';
});
