# 심지회 공동 장부

영수증 사진을 촬영하면 Amazon Bedrock Nova 2 Lite가 상호·결제일·최종 결제금액을 읽어 DynamoDB에 자동 기록하는 모바일 웹입니다.

## AWS 배포 순서

1. AWS CLI와 [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)를 설치하고 서울 리전(`ap-northeast-2`) AWS 자격 증명을 설정합니다.
2. 프로젝트 루트에서 `sam build`를 실행합니다.
3. `sam deploy --guided --region ap-northeast-2`를 실행합니다.
   - `SessionSecret`에는 32자 이상의 무작위 문자열을 사용합니다.
   - 최초에는 `AllowedOrigin`을 `*`로 둡니다.
   - 배포 전 Bedrock 콘솔에서 Amazon Nova 2 Lite 모델을 사용할 수 있는지 확인합니다. 기본 모델 ID는 글로벌 추론 프로필을 사용합니다.
4. 출력된 `ApiUrl`을 복사합니다.
5. AWS Amplify에서 GitHub 저장소 `softbrain75/simji`를 새 앱으로 연결합니다.
6. Amplify 환경 변수 `SIMJI_API_URL`에 4번의 `ApiUrl`을 넣고 `main` 브랜치를 배포합니다.
7. Amplify 배포 URL을 확인한 뒤 `sam deploy`를 한 번 더 실행해 `AllowedOrigin`을 그 URL로 제한합니다.

## AWS 리소스

- `LedgerTable`: DynamoDB 온디맨드 장부 테이블
- `ReceiptBucket`: 외부 공개가 차단된 영수증 이미지 버킷
- `SimjiFunction`: 로그인, 기록 조회, 영수증 분석 API
- `SimjiApi`: API Gateway HTTP API

## 참고

- 영수증은 S3에 비공개 저장되며, 앱은 30분짜리 서명 URL로만 사진을 표시합니다.
- Bedrock 분석이 확신하지 못한 전표는 금액 0원과 `영수증 확인 필요`로 저장됩니다. 다음 단계에서 그 기록을 눌러 수정하는 기능을 추가하면 됩니다.
- AWS 예산 알림은 월 $3, $10 두 단계로 설정해 두는 것을 권장합니다.
