// 引入所需模块
const fs = require('fs');        // 文件系统操作
const path = require('path');    // 路径处理
const axios = require('axios');  // 发送 HTTP 请求
const AdmZip = require('adm-zip'); // 处理 ZIP 文件
const moment = require('moment-timezone'); // 处理日期和时间，带时区

// 定义一系列不希望包含在最终列表中的 IP CIDR 地址块
// 这些看起来主要是 Cloudflare 自己的 IP 段，可能还有其他 CDN 或保留地址
const bannedCidrs = [
    '101.x.x.x/15', // 可能匹配 101.0.0.0/15 或类似的，x 可能是占位符
    '141.101.64.0/18',
    '172.64.0.0/13',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14', // 实际应为 104.24.0.0/14
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '188.114.96.0/20',
    '190.93.240.0/20', // 实际应为 190.93.240.0/20
    '197.234.240.0/22',
    '198.41.128.0/17',
    '131.0.72.0/22'
];

// --- 辅助函数 ---

/**
 * 将 IPv4 地址字符串转换为 32 位无符号整数。
 * 用于 CIDR 范围检查。
 * @param {string} ipString - IPv4 地址字符串 (e.g., "192.168.1.1")
 * @returns {number} - 32 位无符号整数表示
 */
function ipToLong(ipString) {
    // 通过位运算将 IP 的四个部分合并成一个整数
    return ipString.split('.').reduce((res, octet) => (res << 8) + parseInt(octet, 10), 0) >>> 0;
}

/**
 * 检查一个 IP 地址是否属于一个 CIDR 地址块。
 * @param {string} ip - 要检查的 IPv4 地址字符串
 * @param {string} cidr - CIDR 地址块字符串 (e.g., "192.168.1.0/24")
 * @returns {boolean} - 如果 IP 在 CIDR 范围内则返回 true，否则 false
 */
function isIpInCidr(ip, cidr) {
    const [range, bits] = cidr.split('/');
    const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0; // 计算子网掩码的整数形式
    const ipLong = ipToLong(ip);
    const rangeLong = ipToLong(range);
    // 通过位与运算比较网络地址部分是否相同
    return (ipLong & mask) === (rangeLong & mask);
}

/**
 * 将处理后的 IP 列表文件上传到 GitHub 仓库。
 * @param {string} localFilePath - 本地生成的 IP 列表文件的路径
 * @param {string} repoPath - 要在 GitHub 仓库中保存的文件路径 (e.g., "BestProxy/bestproxy.txt")
 * @param {number} ipCount - 文件中包含的 IP 数量
 */
async function uploadToGitHub(localFilePath, repoPath, ipCount) {
    // 获取当前时间（上海时区）并格式化
    const currentTime = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
    // 构建提交信息
    const commitMessage = `Update ${repoPath} - ${currentTime} (Total IPs: ${ipCount})`;

    // 从环境变量获取 GitHub Token 和仓库信息（由 GitHub Actions 自动提供）
    const githubToken = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY; // 格式: "owner/repo"

    // 检查 Token 和仓库信息是否存在
    if (!githubToken || !repository) {
        console.error('Error: GITHUB_TOKEN or GITHUB_REPOSITORY not found in environment variables.');
        process.exit(1); // 退出脚本
    }

    // 设置 GitHub API 请求头
    const headers = {
        'Authorization': `token ${githubToken}`,
        'Content-Type': 'application/json'
    };

    // 读取本地文件内容并进行 Base64 编码（GitHub API 要求）
    const fileContent = fs.readFileSync(localFilePath, 'utf-8');
    const contentBase64 = Buffer.from(fileContent, 'utf-8').toString('base64');

    // 构建 GitHub API URL
    const apiUrl = `https://api.github.com/repos/${repository}/contents/${repoPath}`;

    let existingFileSha = '';
    try {
        // 尝试获取现有文件的 SHA，如果文件存在，更新时需要提供 SHA
        const response = await axios.get(apiUrl, { headers });
        if (response.data && response.data.sha) {
            existingFileSha = response.data.sha;
            console.log(`Found existing file SHA: ${existingFileSha}`);
        }
    } catch (error) {
        // 如果获取失败（比如文件不存在，返回 404），则忽略错误，SHA 保持为空
        if (error.response && error.response.status !== 404) {
            console.error('Error fetching existing file SHA:', error.message);
            // 可以选择退出或继续尝试创建文件
        } else {
             console.log(`File ${repoPath} not found, will create a new one.`);
        }
    }

    // 构建 API 请求体
    const payload = {
        message: commitMessage,
        content: contentBase64
    };
    // 如果找到了现有文件的 SHA，则添加到请求体中以进行更新
    if (existingFileSha) {
        payload.sha = existingFileSha;
    }

    try {
        // 发送 PUT 请求到 GitHub API 来创建或更新文件
        console.log(`Uploading ${repoPath} to GitHub repository ${repository}...`);
        await axios.put(apiUrl, payload, { headers });
        console.log(`Successfully uploaded ${repoPath} with ${ipCount} IPs.`);
    } catch (error) {
        console.error(`Error uploading file to GitHub: ${error.response?.status} ${error.response?.statusText}`);
        if (error.response?.data) {
             console.error("GitHub API Error Details:", error.response.data);
        }
        process.exit(1); // 上传失败则退出
    }
}

// --- 主函数 ---
async function main() {
    // (这里有一些反调试代码，可以忽略)

    const workDir = process.cwd(); // 获取当前工作目录 (通常是仓库根目录)
    const downloadUrl = 'https://zip.baipiao.eu.org/'; // 要下载的 ZIP 文件 URL
    const zipFilePath = path.join(workDir, 'proxy.txt.zip'); // 本地保存 ZIP 文件的路径

    // --- 1. 下载 ZIP 文件 ---
    console.log(`Downloading ZIP file from ${downloadUrl}...`);
    try {
        const response = await axios({
            method: 'get',
            url: downloadUrl,
            responseType: 'stream' // 以流的形式下载
        });
        const writer = fs.createWriteStream(zipFilePath);
        response.data.pipe(writer); // 将下载流写入本地文件

        // 等待写入完成
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        console.log(`Successfully downloaded ZIP file to ${zipFilePath}`);
    } catch (error) {
        console.error(`Error downloading ZIP file: ${error.message}`);
        process.exit(1);
    }

    // --- 2. 解压 ZIP 文件 ---
    console.log(`Extracting ZIP file ${zipFilePath}...`);
    try {
        const zip = new AdmZip(zipFilePath);
        zip.extractAllTo(workDir, /*overwrite*/ true); // 解压到工作目录，覆盖同名文件
        console.log(`Successfully extracted files to ${workDir}`);
        // (可选) 删除下载的 ZIP 文件
        // fs.unlinkSync(zipFilePath);
    } catch (error) {
        console.error(`Error extracting ZIP file: ${error.message}`);
        process.exit(1);
    }

    // --- 3. 读取解压后的 .txt 文件并收集 IP ---
    console.log('Reading extracted text files and collecting IPs...');
    const allFiles = fs.readdirSync(workDir); // 读取工作目录下的所有文件和目录名
    const ipSet = new Set(); // 使用 Set 来自动去重

    allFiles.forEach(fileName => {
        if (fileName.endsWith('.txt')) { // 只处理 .txt 文件
            const filePath = path.join(workDir, fileName);
            try {
                console.log(`Processing file: ${fileName}`);
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                fileContent.split(/\r?\n/).forEach(line => { // 按行分割
                    const ip = line.trim(); // 去除首尾空格
                    if (ip) { // 如果行不为空
                        ipSet.add(ip); // 添加到 Set 中
                    }
                });
            } catch (readError) {
                 console.warn(`Warning: Could not read file ${fileName}: ${readError.message}`);
            }
             // (可选) 删除处理过的 .txt 文件
             // fs.unlinkSync(filePath);
        }
    });
    console.log(`Collected ${ipSet.size} unique IPs initially.`);

    // --- 4. 过滤掉不需要的 IP 地址 ---
    console.log('Filtering IPs against banned CIDRs...');
    let filteredIps = Array.from(ipSet).filter(ip => {
        // 对每个 IP，检查它是否在任何一个 bannedCidrs 范围内
        for (const cidr of bannedCidrs) {
            try {
                 if (isIpInCidr(ip, cidr)) {
                     // console.log(`Filtering out ${ip} (matches ${cidr})`); // 取消注释以查看过滤详情
                     return false; // 如果在范围内，则过滤掉 (返回 false)
                 }
            } catch (cidrError) {
                 // 如果 IP 格式无效或 CIDR 格式无效导致 isIpInCidr 出错，也过滤掉
                 // console.warn(`Warning: Error checking IP ${ip} against CIDR ${cidr}: ${cidrError.message}. Filtering out.`);
                 return false;
            }
        }
        return true; // 如果不在任何 bannedCidrs 范围内，则保留 (返回 true)
    });
    console.log(`Filtered down to ${filteredIps.length} IPs.`);

    // --- 5. 随机打乱 IP 顺序 ---
    console.log('Shuffling the filtered IPs...');
    // 使用 Fisher-Yates (Knuth) 随机排序算法
    for (let i = filteredIps.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [filteredIps[i], filteredIps[j]] = [filteredIps[j], filteredIps[i]]; // 交换元素
    }
    console.log('IPs shuffled.');

    // --- 6. 将结果写入目标文件 ---
    const outputDir = path.join(workDir, 'BestProxy'); // 定义输出目录
    // 确保输出目录存在
    if (!fs.existsSync(outputDir)){
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }
    const outputFilePath = path.join(outputDir, 'bestproxy.txt'); // 定义输出文件路径
    console.log(`Writing ${filteredIps.length} IPs to ${outputFilePath}...`);
    try {
        fs.writeFileSync(outputFilePath, filteredIps.join('\n'), 'utf-8'); // 将 IP 数组用换行符连接并写入文件
        console.log(`Successfully wrote IPs to ${outputFilePath}`);
    } catch (writeError) {
        console.error(`Error writing output file: ${writeError.message}`);
        process.exit(1);
    }

    // --- 7. (可选的冗余检查) 验证写入的文件 ---
    /*
    console.log('Verifying written file against banned CIDRs...');
    const writtenContent = fs.readFileSync(outputFilePath, 'utf-8').split(/\r?\n/);
    for (const ip of writtenContent) {
        if (!ip) continue; // 跳过空行
        for (const cidr of bannedCidrs) {
            try {
                if (isIpInCidr(ip, cidr)) {
                    console.error(`Error: Banned IP ${ip} (matches ${cidr}) found in the final output file!`);
                    process.exit(1); // 发现不该存在的 IP，退出
                }
            } catch(verifyError) {
                 console.error(`Error verifying IP ${ip} against CIDR ${cidr}: ${verifyError.message}`);
                 process.exit(1);
            }
        }
    }
    console.log('Verification successful.');
    */

    // --- 8. 上传到 GitHub ---
    const ipCount = filteredIps.length; // 获取最终写入的 IP 数量
    const repoOutputPath = 'BestProxy/bestproxy.txt'; // GitHub 仓库中的目标路径
    await uploadToGitHub(outputFilePath, repoOutputPath, ipCount);

    console.log("Script finished successfully.");
}

// 执行主函数，并在完成后退出
main().catch(error => {
    console.error("An unexpected error occurred in main:", error);
    process.exit(1); // 发生未捕获错误时退出
});

