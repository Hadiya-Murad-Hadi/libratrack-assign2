# LibraTrack – Library Management System
Node.js + Express + MySQL. Modules: (1) Authentication, (2) Book catalog, (3) Issue/return with fines.
Demo admin: `admin@libratrack.com` / `Admin@123` (created on first start). Members self-register.
Rules: 14-day loans, max 3 active loans, Rs 10 fine per overdue day.
The app creates the database + tables itself on start (schema.sql). It reads DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME (or Beanstalk's RDS_* vars), plus JWT_SECRET and PORT.

## Run locally
    npm install && DB_USER=root DB_PASSWORD=yourpass npm start     # http://localhost:8080

## Part I – EC2 (IaaS)
1. Launch Ubuntu 22.04/24.04 `t2.micro`/`t3.micro`; create a key pair (.pem). Security group inbound: SSH 22 (My IP), HTTP 80 (anywhere), MySQL 3306 (anywhere, so the instructor can verify).
2. `chmod 400 key.pem && ssh -i key.pem ubuntu@<EC2_PUBLIC_IP>`
3. Install software:
       sudo apt update && sudo apt install -y mysql-server nginx unzip
       curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
       sudo npm install -g pm2
4. Database (replace the passwords):
       sudo mysql
       CREATE DATABASE libratrack;
       CREATE USER 'libra'@'localhost' IDENTIFIED BY 'AppPass#123';
       GRANT ALL ON libratrack.* TO 'libra'@'localhost';
       CREATE USER 'readonly'@'%' IDENTIFIED BY 'ReadOnly#123';
       GRANT SELECT ON libratrack.* TO 'readonly'@'%';
       FLUSH PRIVILEGES; EXIT;
   Allow remote reads: in `/etc/mysql/mysql.conf.d/mysqld.cnf` set `bind-address = 0.0.0.0`, then `sudo systemctl restart mysql`.
5. Upload code from your PC: `scp -i key.pem libratrack.zip ubuntu@<IP>:~` then
       unzip libratrack.zip -d libratrack && cd libratrack && npm install --omit=dev
       DB_USER=libra DB_PASSWORD='AppPass#123' DB_NAME=libratrack JWT_SECRET=anylongrandomtext pm2 start server.js --name libratrack
       pm2 save && pm2 startup     # run the command it prints
   (Optional manual schema: `mysql -u libra -p libratrack < schema.sql`; the app also does this on start.)
6. Nginx on port 80: write `/etc/nginx/sites-available/default` as
       server { listen 80; location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; } }
   then `sudo nginx -t && sudo systemctl restart nginx`. Open `http://<EC2_PUBLIC_IP>`.
7. Check: `http://<IP>/api/health` returns `{"status":"ok"}`.

## Part II – S3 + Elastic Beanstalk + RDS (PaaS)
1. Zip the project contents (files at the zip root, no `node_modules`): `libratrack.zip` is already built that way.
2. S3: create a bucket and upload `libratrack.zip`.
3. RDS: Create database, MySQL, Free tier template, DB instance identifier `libratrack-db`, master user `admin`, set a password, initial database name `libratrack`, Public access = Yes. After creation, add an inbound rule on its security group: MySQL 3306 from anywhere (or from the Beanstalk security group).
4. Elastic Beanstalk: Create application, platform Node.js, "Sample application" first is fine, or choose "Upload your code" > use the S3 object URL of the zip.
   Configuration > Software > Environment properties: `DB_HOST` (RDS endpoint), `DB_PORT` 3306, `DB_USER` admin, `DB_PASSWORD`, `DB_NAME` libratrack, `JWT_SECRET`.
5. Open the environment URL (e.g. `xxx.elasticbeanstalk.com`); `/api/health` should say ok.
6. Create the read-only user once, from the EC2 box (or any MySQL client):
       mysql -h <RDS_ENDPOINT> -u admin -p
       CREATE USER 'readonly'@'%' IDENTIFIED BY 'ReadOnly#123'; GRANT SELECT ON libratrack.* TO 'readonly'@'%'; FLUSH PRIVILEGES;

## Form fields cheat sheet
- Web Application Title: LibraTrack – Library Management System
- EC2 Public IP / IaaS DB port 3306 / name `libratrack` / read-only user `readonly` + its password
- PaaS URL = Beanstalk environment URL; PaaS DB host = RDS endpoint; port 3306; name `libratrack`; same read-only user.

## Cost warning
Stop or terminate the EC2 instance, Beanstalk environment and RDS instance after your assignment is graded.
