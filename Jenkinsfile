pipeline {
    agent any

    stages {
        stage('Checkout') {
            steps {
                git branch: 'main',
                    url: 'https://github.com/Hadiya-Murad-Hadi/libratrack-assign2.git'
            }
        }

        stage('Build in Docker') {
            agent {
                docker {
                    image 'node:20-alpine'
                    reuseNode true
                }
            }
            steps {
                sh 'npm install --omit=dev'
                sh 'node --check server.js'
            }
        }

        stage('Deploy Part II') {
            steps {
                sh 'docker compose -f docker-compose-part2.yml up -d'
            }
        }
    }

    post {
        always {
            script {
                def committerEmail = sh(
                    script: 'git log -1 --pretty=format:%ae',
                    returnStdout: true
                ).trim()

                if (committerEmail) {
                    emailext(
                        to: committerEmail,
                        subject: "LibraTrack Build #${env.BUILD_NUMBER} - ${currentBuild.currentResult}",
                        body: """
                        Hello,

                        Your LibraTrack Jenkins build has completed.

                        Build Number: ${env.BUILD_NUMBER}
                        Build Status: ${currentBuild.currentResult}

                        Repository: https://github.com/Hadiya-Murad-Hadi/libratrack-assign2

                        Regards,
                        Jenkins
                        """
                    )
                }
            }
        }
    }
}
