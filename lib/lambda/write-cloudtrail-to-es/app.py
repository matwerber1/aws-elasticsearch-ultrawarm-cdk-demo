from __future__ import print_function
import boto3
import json
import gzip
import os
import datetime
from base64 import b64decode
import requests
from requests_aws4auth import AWS4Auth

region = os.environ.get('ES_REGION')
service = 'es'
credentials = boto3.Session().get_credentials()
awsauth = AWS4Auth(credentials.access_key, credentials.secret_key, region, service, session_token=credentials.token)

host = os.environ.get('ES_ENDPOINT')
index_prefix = os.environ.get('ES_INDEX_PREFIX')
doc_type = os.environ.get('ES_DOC_TYPE')

headers = {"Content-Type": "application/json"}

def decompress(data) -> bytes:
    return gzip.decompress(data)

def decode_record(data: dict) -> dict:
    x = decompress(b64decode(data['data']))
    return json.loads(x.decode('utf8'))

def decode_event(event: dict) -> dict:
    return decode_record(event['awslogs'])

def handler(event, ctx) -> None:
    event = decode_event(event)
    print(json.dumps(event))

    logEvents = event['logEvents']
    print("Log events:\n{}".format(logEvents))

    count = 0
    errors = 0
    print('Processing records...')
    for record in logEvents:
        id = record['id']
        document = json.loads(record['message'])
        timestamp = record['timestamp'] / 1000
        dateString = datetime.datetime.fromtimestamp(timestamp).strftime("%Y%m%d")
        url = host + '/' + index_prefix + '-' + dateString + '/' + doc_type + '/'
        r = requests.put(url + id, auth=awsauth, json=document, headers=headers)
        if (r.status_code > 299):
            print('Failed to post record{}:\n  - STATUS {} - {}'.format(id, r.status_code, r.text))
            errors = 0
        else:
            count += 1
    print('{} records posted to Elasticsearch.'.format(count))
    if (errors > 0):
        print('{} failed records not posted to Elasticsearch.'.format(count))

# Based on: 
# https://docs.aws.amazon.com/elasticsearch-service/latest/developerguide/es-aws-integrations.html#es-aws-integrations-dynamodb-es