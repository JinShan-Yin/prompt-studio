const { spawn, exec } = require('child_process');
const http = require('http');

console.log('========================================');
console.log(' 正在启动 Prompt Studio 智能工作台...');
console.log('========================================');

// 1. 自动清理 3080 和 3081 端口
function killPort(port) {
    return new Promise((resolve) => {
        const cmd = `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`;
        exec(cmd, () => resolve()); // 无论成功失败都继续
    });
}

async function main() {
    console.log('[0/3] 检查并清理旧进程...');
    await killPort(3080);
    await killPort(3081);

    console.log('[1/3] 启动 DSH 核心引擎...');
    // 启动后端 dsh
    const dshProcess = spawn('dsh', ['web', '--patch', './cordis.patch.yml'], { shell: true });
    let token = '';
    let isFrontendStarted = false;

    // 监听 DSH 的输出，精准捕获 Token
    dshProcess.stdout.on('data', (data) => {
        const text = data.toString();
        process.stdout.write(text);

        if (!token) {
            const match = text.match(/token=([a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                token = match[1];
                console.log(`\n✅ 成功捕获 DSH Token: ${token}`);
                startFrontend();
            }
        }
    });

    function startFrontend() {
        if (isFrontendStarted) return;
        isFrontendStarted = true;

        console.log('[2/3] 启动前端界面代理...');
        const nodeProcess = spawn('node', ['server-ui.js'], { shell: true });
        nodeProcess.stdout.on('data', (d) => process.stdout.write(d));

        // 延迟 2 秒等代理启动完毕，自动打开浏览器
        setTimeout(() => {
            const url = `http://127.0.0.1:3081/?token=${token}`;
            console.log(`\n[3/3] 🚀 正在为您自动打开浏览器: ${url}`);
            exec(`start ${url}`);
        }, 2000);
    }

    // 退出清理
    process.on('SIGINT', () => {
        console.log('\n正在关闭所有服务...');
        dshProcess.kill();
        process.exit();
    });
}

main();