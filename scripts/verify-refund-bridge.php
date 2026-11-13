<?php
// Offline bridge test: WordPress, database and wp_mail are replaced by fixtures.
define('ABSPATH', __DIR__); define('IUW_BRIDGE_SECRET', 'test-only-bridge-secret');
function add_action(...$args) {}
class WP_Error { public function __construct(public $code, public $message, public $data=[]) {} }
class WP_REST_Request { public function __construct(public $params=[], public $headers=[]) {} public function get_param($key){return $this->params[$key]??null;} public function get_header($key){return $this->headers[$key]??'';} }
function sanitize_text_field($text){return trim(strip_tags($text));}
function is_email($email){return filter_var($email,FILTER_VALIDATE_EMAIL);}
class FakeItem {public $quantity=4;public function get_product_id(){return 501;}public function get_quantity(){return $this->quantity;}}
class FakeOrder {public $paid=true;public function is_paid(){return $this->paid;}public function get_items(){return [$GLOBALS['item']];}}
function wc_get_order($id){return $id===1234?$GLOBALS['order']:null;}
function wp_mail($to,$subject,$body,$headers){$GLOBALS['emails'][]=compact('to','subject','body','headers');return $GLOBALS['mailWorks'];}
class FakeDB {
 public $row;
 public function prepare($sql,...$args){return [$sql,$args];}
 public function get_row($query){return $this->row?clone $this->row:null;}
 public function query($query){[$sql,$args]=$query;
  if(str_contains($sql,"SET refund_status = 'sending'")){if($this->row->status==='paid'&&in_array($this->row->refund_status,[null,'failed'],true)){$this->row->refund_status='sending';$this->row->refund_reason=$args[0];return 1;}return 0;}
  if(str_contains($sql,"SET refund_status = 'failed'")){$this->row->refund_status='failed';return 1;}
  if(str_contains($sql,"SET refund_status = 'sent'")){$this->row->refund_status='sent';$this->row->refund_requested_at='2026-11-13 08:00:00';return 1;}
  throw new Exception('Unexpected query');
 }
}
require __DIR__.'/../wordpress/iuw-api-bridge.php';
function fixture(){global $wpdb,$item,$order,$emails,$mailWorks;$wpdb=new FakeDB;$wpdb->row=(object)['id'=>'req-demo','customer_wp_user_id'=>1,'requester_supplier_id'=>null,'status'=>'paid','woo_order_id'=>1234,'woo_order_number'=>'1234','wc_product_id'=>501,'product_name'=>'5kg Party Ice Bag','qty'=>4,'supplier_email'=>'supplier@example.test','supplier_name'=>'Crystal Ice','customer_email'=>'buyer@example.test','refund_status'=>null,'refund_requested_at'=>null];$item=new FakeItem;$order=new FakeOrder;$emails=[];$mailWorks=true;}
function request($changes=[]){return new WP_REST_Request(array_merge(['requestId'=>'req-demo','customerWpUserId'=>1,'requesterSupplierId'=>null,'reason'=>'The bags arrived damaged.'],$changes));}
function check($ok,$message){if(!$ok)throw new Exception($message);}
fixture();$result=iuw_bridge_refund_request(request());check(is_array($result)&&$result['status']==='sent','Send succeeds');check(count($emails)===1,'One email');check($emails[0]['to']==='supplier@example.test','Recipient comes from supplier record');check(str_contains($emails[0]['subject'],'1234')&&str_contains($emails[0]['subject'],'5kg Party Ice Bag'),'Subject names exact order/product');check(str_contains($emails[0]['body'],'Quantity: 4')&&str_contains($emails[0]['body'],'The bags arrived damaged.'),'Body includes quantity and reason');check($wpdb->row->status==='paid','Request does not issue money refund');
iuw_bridge_refund_request(request());check(count($emails)===1,'Repeated send is idempotent');
fixture();$result=iuw_bridge_refund_request(request(['customerWpUserId'=>2]));check($result instanceof WP_Error&&$result->data['status']===403&&count($emails)===0,'Other buyer rejected');
fixture();$wpdb->row->requester_supplier_id='company-a';$result=iuw_bridge_refund_request(request(['requesterSupplierId'=>'company-b']));check($result instanceof WP_Error&&count($emails)===0,'Other company rejected');
fixture();$wpdb->row->status='open';check(iuw_bridge_refund_request(request()) instanceof WP_Error&&count($emails)===0,'Unpaid rejected');
fixture();$order->paid=false;check(iuw_bridge_refund_request(request()) instanceof WP_Error&&count($emails)===0,'Woo payment rechecked');
fixture();$item->quantity=3;check(iuw_bridge_refund_request(request()) instanceof WP_Error&&count($emails)===0,'Wrong product quantity rejected');
fixture();$wpdb->row->supplier_email="supplier@example.test\r\nBcc: attacker@example.test";check(iuw_bridge_refund_request(request()) instanceof WP_Error&&count($emails)===0,'Email header injection rejected');
fixture();$wpdb->row->refund_status='sending';check(iuw_bridge_refund_request(request()) instanceof WP_Error&&count($emails)===0,'Concurrent send rejected');
fixture();$mailWorks=false;check(iuw_bridge_refund_request(request()) instanceof WP_Error&&$wpdb->row->refund_status==='failed','Mailer failure retained for retry');$mailWorks=true;iuw_bridge_refund_request(request());check($wpdb->row->refund_status==='sent','Explicit retry after confirmed failure');
fixture();iuw_bridge_refund_request(request(['to'=>'attacker@example.test','subject'=>'Fake subject','body'=>'Fake product']));check($emails[0]['to']==='supplier@example.test'&&$emails[0]['subject']!=='Fake subject','Caller cannot replace recipient or order details');
check(iuw_bridge_authorize(new WP_REST_Request([],['x_iuw_bridge_secret'=>'wrong'])) instanceof WP_Error,'Bridge rejects invalid secret');
echo "Offline refund bridge checks passed: identity, paid order/product, supplier recipient, content, duplicate claim, failure/retry and header safety. No emails sent.\n";
