#!/bin/bash

# 增强版FTP文件传输脚本
# 用法: ./ftp_transfer.sh remote_ip username password remote_dir

# 检查是否安装了ftp客户端
if ! command -v ftp &> /dev/null; then
    echo "Error: ftp command not found. Please install ftp client first."
    exit 1
fi

# 检查参数数量
if [ $# -ne 4 ]; then
    echo "Usage: $0 remote_ip username password remote_dir"
    exit 1
fi

# 获取参数
REMOTE_IP=$1
USERNAME=$2
PASSWORD=$3
REMOTE_DIR=$4
# 定义文件名
MULTICAST_FILE=multicast_cfg.json
OSS_FILE=oss_cfg.json
MAC_FILE=static_mac_cfg.json
INIT_FILE=tsnlight_init_cfg.json
PLAN_FILE=tsnlight_plan_cfg.json

# 创建临时.netrc文件
NETRC_FILE=$(mktemp)
echo "machine $REMOTE_IP login $USERNAME password $PASSWORD" > $NETRC_FILE
chmod 600 $NETRC_FILE

# 执行FTP传输
echo "Starting FTP transfer of $LOCAL_FILE to $REMOTE_IP:$REMOTE_DIR..."

# 使用临时文件捕获FTP输出
FTP_OUTPUT=$(mktemp)
FTP_RESULT=0

# 执行FTP命令并捕获退出状态
if ! ftp -inv $REMOTE_IP << EOF > $FTP_OUTPUT 2>&1
user $USERNAME $PASSWORD
binary
passive

cd "$REMOTE_DIR"
pwd

cd "TSNLight/config"
pwd
put "$INIT_FILE"
put "$PLAN_FILE"
cd "../.."
pwd

cd "l2switch/config"
pwd
put "$MAC_FILE"
cd "../.."
pwd

cd "multicast/config"
pwd
put "$MULTICAST_FILE"
cd "../.."
pwd

cd "opensync/802.1as/config"
pwd
put "$OSS_FILE"

quit
EOF
then
    FTP_RESULT=1
fi


# 检查FTP输出中是否有错误
if grep -q "failed\|Failed\|error\|denied" $FTP_OUTPUT; then
    FTP_RESULT=1
fi

# 显示FTP输出
cat $FTP_OUTPUT
rm -f $FTP_OUTPUT

rm -f $NETRC_FILE

if [ $FTP_RESULT -ne 0 ]; then
    echo "Error: FTP transfer failed with exit code $FTP_RESULT"
    exit 1
else
    echo "Success: File transferred to $REMOTE_IP:$REMOTE_DIR/$FILENAME"
    exit 0
fi
